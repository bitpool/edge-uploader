/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

module.exports = function (RED) {
    const axios = require('axios');
    const { Pool, FileStorageCache, DataType } = require("./uploader")
    const os = require("os");
    const { Mutex } = require("async-mutex");
    const camelCase = require('camelcase');
    const { Agent } = require('https');

    const HTTP_TIMEOUT_SECS = 10;                   // Default HTTP session timeout in seconds
    const DATA_UPLOAD_INTERVAL_SECS = 60;           // Interval in seconds to check for data upload (default, configurable by user)
    const DATA_UPLOAD_CHUNK_SIZE = 10;              // Number of records to upload in a single batch
    const DATA_STORAGE_PATH = './bitpool-data';
    const APP_POLL_UI_SECS = 1;
    const APP_POLL_ENQUEUE_SECS = 1;
    const APP_POLL_DEQUEUE_SECS = 2;

    function BITPOOL(config) {
        RED.nodes.createNode(this, config);

        // Config options for Bitpool API
        let apiKeyConfig = RED.nodes.getNode(config.apiKey);
        let poolSettings = RED.nodes.getNode(config.pool_settings);
        let public = poolSettings.public || false;
        let virtual = poolSettings.virtual || false;

        let api_key = cleanUserInput(apiKeyConfig.api_key) || "";
        let pool_name = cleanUserInput(poolSettings.pool_name) || "";
        let api_endpoint = cleanUserInput(apiKeyConfig.api_endpoint) || "api.bitpool.com";

        // Config options for status monitoring
        let timeoutSecs = Number(config.timeout || HTTP_TIMEOUT_SECS);
        let uploadIntervalSecs = Number(config.uploadInterval || DATA_UPLOAD_INTERVAL_SECS);
        let bpChkShowDebugWarnings = config.bpChkShowDebugWarnings;

        // Timers
        let timerCheckUI = null;
        let timerEnqueue = null;
        let timerDequeue = null;
        let enqueuedStreamBlocks = [];

        // Runtime variables
        const timers = {};
        this.mutex = new Mutex();
        this.pool = new Pool();
        this.fileCache = new FileStorageCache(DATA_STORAGE_PATH);
        this.rootUrlv2 = `https://${api_endpoint}/public/v2/`;
        this.rootUrlv3 = `https://${api_endpoint}/public/v3/`;
        this.initComplete = false;
        this.PoolTags = config.PoolTags;
        this.lastUploadCheckTimeUI = new Date();
        this.lastUploadCheckTimeEnqueue = new Date();

        let node = this;

        const axiosInstance = axios.create({
            timeout: timeoutSecs * 1000,
            headers: {
                "Authorization": api_key,
                "Content-Type": "application/json"
            },
            httpsAgent: new Agent({ keepAlive: false })
        });

        async function initializeNode() {
            try {
                // Ensure all previous timers are stopped
                try {
                    stopAllTimers();
                } catch (error) {
                    logError("Error stopping timers:", error.message || error);
                }

                // Check if the API key is set
                if (!isValidApiKey(api_key)) {
                    logError("API key is invalid or empty, please check to continue.");
                    return;
                }

                // Check if the pool name is set
                if (!isValidPoolName(pool_name)) {
                    logError("Pool Name is invalid or empty, please check to continue.");
                    return;
                }

                if (bpChkShowDebugWarnings) {
                    try {
                        // Send the pool configuration to the debug window on startup                
                        node.send({
                            "payload": {
                                "config": {
                                    "api_key": apiKeyConfig.api_key,
                                    "pool_name": pool_name,
                                    "api_endpoint_v2": node.rootUrlv2,
                                    "api_endpoint_v3": node.rootUrlv3,
                                    "upload_on_expired_secs": uploadIntervalSecs,
                                    "http_timeout_secs": timeoutSecs,
                                    "option_show_debug_warnings": bpChkShowDebugWarnings,
                                }
                            }
                        });
                    } catch (error) {
                        logError('Failed to load configuration state.', error || error.message);
                    }
                }

                try {
                    // Wait for the system to load, then set up the pool and station with tags
                    setTimeout(async () => {
                        try {
                            node.pool = new Pool();

                            // Create pool object
                            node.pool.setPoolName(pool_name);

                            // Add default tags and clean
                            let defaultTags = [
                                `operatingSystem=${os.version()}`,
                                `nodejsVersion=${process.version}`,
                                `nodeRedVersion=${RED.version()}`
                            ];
                            let poolTagsOnNode = node.pool.cleanTags(node.PoolTags + "," + defaultTags.join(','))

                            // Get pool details from API
                            let serverPool = await postAddUpdatePool(pool_name);
                            if (serverPool.PoolKey && isValidGUID(serverPool.PoolKey)) {
                                node.pool.setPoolKey(serverPool.PoolKey);
                                await postAddPoolTags(serverPool.PoolKey, poolTagsOnNode);
                                node.pool.setPoolTags(poolTagsOnNode);

                                // Get station details from API
                                let stationID = await postAddUpdateStation(serverPool.PoolKey, pool_name);
                                node.pool.setStationId(stationID)

                                updateStatusMsg({ fill: "green", shape: "dot", text: "Pool initialised OK" });

                            } else {
                                logWarn("Error initializing:", error.message || error);
                                node.status({ fill: "red", shape: "ring", text: "Error initializing" });
                            }
                        } catch (error) {
                            logError("Error initializing:", error.message || error);
                            logWarn("Please make sure the API is valid and the Pool Name is correct.");
                            node.status({ fill: "red", shape: "ring", text: "Error, check valid API key and Pool Name" });
                        }
                    }, 1);

                } catch (error) {
                    logError("Error initializing:", error.message || error);
                    node.status({ fill: "red", shape: "ring", text: "Error initializing" });
                }

                backPopStreams();

                // Set up timer to update the UI
                clearInterval(timerCheckUI);
                if (timerCheckUI === null) {
                    timers.uiTimer = setInterval(async () => {
                        try {
                            const now = new Date();
                            const elapsedSeconds = Math.floor((now - node.lastUploadCheckTimeUI) / 1000);
                            const remainingSeconds = uploadIntervalSecs - elapsedSeconds;
                            const cacheSize = node.fileCache.getSize()
                            const totalPoolRecordCount = node.pool.getCountOfAllRecords();
                            const streamCount = node.pool.getStreamCount();

                            if (remainingSeconds < 0) {
                                node.lastUploadCheckTimeUI = now;

                            } else {
                                const formattedTime = formatDateToDdHhMmSs(remainingSeconds);
                                let message = `In:(${totalPoolRecordCount}) Out:(${enqueuedStreamBlocks.length}) Time:(${formattedTime}) Streams:(${streamCount})`;
                                if (cacheSize > 0) {
                                    const storedKeys = node.fileCache.listStoredKeys();
                                    const countPoolCachedStreams = Array.from(storedKeys).reduce((count, [key]) => {
                                        return count + (node.pool.hasStreamKey(key) ? 1 : 0);
                                    }, 0);

                                    if (countPoolCachedStreams > 0) {
                                        message = `In:(${totalPoolRecordCount}) Out:(${enqueuedStreamBlocks.length}) Time:(${formattedTime}) Streams:(${streamCount}) Cached:(${countPoolCachedStreams})`;
                                    }
                                }

                                updateStatusMsg({ fill: "blue", shape: "dot", text: message });
                            }

                        } catch (error) {
                            logError("Error in Timer:", error.message || error);
                        }
                    }, APP_POLL_UI_SECS * 1000);
                } else {
                    logWarn("At initializeNode(), the upload timer is already running!");
                }

                // Set up timer to enqueue data
                clearInterval(timerEnqueue);
                if (timerEnqueue === null) {
                    timers.enqueueTimer = setInterval(async () => {
                        const now = new Date();
                        const elapsedSeconds = Math.floor((now - node.lastUploadCheckTimeEnqueue) / 1000);
                        const remainingSeconds = uploadIntervalSecs - elapsedSeconds;

                        if (remainingSeconds <= 0) {
                            await pushDataToUploadQueue();
                            node.lastUploadCheckTimeEnqueue = now;
                        }

                    }, APP_POLL_ENQUEUE_SECS * 1000);
                } else {
                    logWarn("At initializeNode(), the upload timer is already running!");
                }

                // Set up timer to dequeue data
                clearInterval(timerDequeue);
                if (timerDequeue === null) {
                    timers.dequeueTimer = setInterval(async () => {
                        await uploadQueuedDataNow();
                    }, APP_POLL_DEQUEUE_SECS * 1000);
                } else {
                    logWarn("At initializeNode(), the upload timer is already running!");
                }

            } catch (error) {
                logError("Error on initialise:", error.message || error);
            } finally {
                node.initComplete = true;
            }
        }

        initializeNode();

        async function backPopStreams() {
            try {
                const poolKey = node.pool.getPoolKey();
                if (!poolKey) {
                    setTimeout(backPopStreams, getRandomNumber(500, 3000));
                    return;
                }

                let serverStreams = await getPoolStreams(poolKey);
                if (serverStreams) {
                    for (const serverStream of serverStreams) {
                        node.pool.addStreamName(serverStream.Name);
                        node.pool.updateStreamKey(serverStream.Name, serverStream.StreamKey);
                        node.pool.setDataType(serverStream.Name, serverStream.DataType);
                    }
                } else {
                    logWarn(`No streams found for pool (${node.pool.getPoolName()}).`);
                }

                if (bpChkShowDebugWarnings) {
                    // Send the pool object to the debug window on startup 
                    node.send({
                        "payload": {
                            "pool": node.pool
                        }
                    });
                }

            } catch (error) {
                logError("Error in Streams Timer:", error.message || error);
            }
        }

        async function pushDataToUploadQueue() {
            try {
                let streams = node.pool.getStreamKeyList();
                for (const stream of streams) {
                    if (stream) {
                        await enqueueStreamDataForUpload(stream);
                    }
                }
            } catch (error) {
                logError("Error in Upload Queue Timer:", error.message || error);
            }
        }

        async function uploadQueuedDataNow() {
            try {
                if (enqueuedStreamBlocks.length > 0) {
                    const maxNumberOfStreamsPerBulkPost = DATA_UPLOAD_CHUNK_SIZE;
                    while (enqueuedStreamBlocks.length > 0) {
                        const chunk = enqueuedStreamBlocks.splice(0, maxNumberOfStreamsPerBulkPost);
                        const result = await postBulkStreamData(chunk);
                        if (!result) {
                            logWarn(`Failed to upload stream data`);
                        }
                    }
                }
            } catch (error) {
                logError("Error in Upload Post Timer:", error.message || error);
            } finally {
                enqueuedStreamBlocks = [];
            }
        }

        node.on('input', async function (msg, send, done) {

            if (node.initComplete) {

                try {
                    if (msg.BPCommand == "REBUILD") {
                        logInfo("The command REBUILD is no longer supported (use CREATE_CONFIG). Note, CREATE_CONFIG will delete all exsiting configuration data.")

                    } else if (msg.BPCommand == "SHOW_CONFIG") {    // ----------------------------------------------
                        send({
                            "payload": {
                                "config": {
                                    "api_key": apiKeyConfig.api_key,
                                    "pool_name": pool_name,
                                    "api_endpoint_v2": node.rootUrlv2,
                                    "api_endpoint_v3": node.rootUrlv3,
                                    "upload_on_expired_secs": uploadIntervalSecs,
                                    "http_timeout_secs": timeoutSecs,
                                    "option_show_debug_warnings": bpChkShowDebugWarnings,
                                }
                            }
                        });
                    } else if (msg.BPCommand == "SHOW_POOL") {      // ----------------------------------------------
                        send({
                            "payload": {
                                "pool": node.pool
                            }
                        });
                    } else if (msg.BPCommand == "SHOW_CACHE") {      // ----------------------------------------------

                        const storedKeys = node.fileCache.listStoredKeys();
                        if (storedKeys && storedKeys.size > 0) {
                            let foundAnEntry = false
                            for (const [key, value] of storedKeys) {
                                try {
                                    if (node.fileCache.streamKeyExists(key)) {
                                        let dataType = node.pool.getStreamByNameOrKey(key).getDataType();
                                        if (dataType) {
                                            const dataEntries = await node.fileCache.retrieveData(key, dataType);
                                            node.send({
                                                "payload": {
                                                    "key": key,
                                                    "data": dataEntries
                                                }
                                            });
                                            foundAnEntry = true
                                        }
                                    }
                                } catch (error) { }
                            }
                            if (!foundAnEntry) {
                                logInfo(`Did not find cached data for this pool.`);
                            }
                        } else {
                            logInfo(`There are no stored cached records.`);
                        }

                    } else if (msg.BPCommand == "CREATE_POOL") {    // ----------------------------------------------
                        node.pool = new Pool();
                        node.initComplete = false;
                        initializeNode();
                        const poolName = node.pool.getPoolName();
                        if (poolName) {
                            logInfo(`Rebuilt the pool (${poolName}).`);
                        } else {
                            logInfo(`Built a new pool.`);
                        }

                    } else if (msg.BPCommand == "SAVE_POOL") {      // ----------------------------------------------
                        logInfo("The command SAVE_POOL is no longer supported in this version.")

                    } else if (msg.BPCommand == "PURGE_DATA") {     // ----------------------------------------------
                        node.pool.purgeRecordsOnly();
                        node.fileCache.purge();
                        logInfo(`Purged all record data stored on this pool (${node.pool.getPoolName()}) node.`);

                    } else if (msg.BPCommand == "UPLOAD_DATA") {    // ----------------------------------------------
                        try {
                            await pushDataToUploadQueue();
                            await uploadQueuedDataNow();
                            logInfo(`Uploaded all record data stored on this pool (${node.pool.getPoolName()}) node.`);

                        } catch (error) {
                            logError('Did not find stored pool configuration, will configure using defaults.', error || error.message);
                        }

                    } else {
                        if (msg.topic && msg.topic.trim() !== "") {
                            if (node.initComplete) {
                                let streamName = msg.topic;
                                let areStreamTagsPosted = false;
                                node.pool.addStreamName(streamName);

                                let streamKey = null;
                                let utcSeconds = msg.utcSeconds !== undefined ? msg.utcSeconds : null;
                                if (utcSeconds !== null) {
                                    let recordDate = new Date(utcSeconds * 1000);
                                    streamKey, areStreamTagsPosted = node.pool.getStreamByNameOrKey(streamName).addData(msg.payload, recordDate);
                                } else {
                                    streamKey, areStreamTagsPosted = node.pool.getStreamByNameOrKey(streamName).addData(msg.payload);
                                }

                                if (!streamKey) {
                                    // Ensure that only one stream is created at a time, else you will ddos the api
                                    // Other events will continue to append data until the stream is configured.
                                    // A Stream Key only exists if it has been configured using the Stream Name.
                                    let release;
                                    try {
                                        release = await node.mutex.acquire();
                                    } catch (error) {
                                        return;
                                    }

                                    try {
                                        let poolKey = node.pool.getPoolKey();
                                        let stationId = node.pool.getStationId();
                                        let dataType = node.pool.getStreamByNameOrKey(streamName).getDataType();
                                        if (poolKey && stationId && streamName && dataType) {
                                            let stream = await postAddUpdateStream(poolKey, stationId, streamName, dataType);
                                            node.pool.updateStreamKey(streamName, stream.StreamKey);
                                        }
                                    } catch (error) { }
                                    finally {
                                        release();
                                    }
                                }

                                // Check if tags have been posted. Do one off post if not
                                if (!areStreamTagsPosted && streamKey) {
                                    node.pool.getStreamByNameOrKey(streamName).setTagsPosted(true);

                                    let streamTags = msg.meta?.split(/\s*,\s*/) || null;
                                    if (streamTags) {
                                        streamTags = _removeNameSpacePrefix(streamTags);
                                        streamTags = [...new Set(streamTags)];
                                    }
                                    node.pool.getStreamByNameOrKey(streamName).updateTags(streamTags);
                                    await postAddStreamTags(streamKey, streamTags)
                                }
                            } else {
                                updateStatusMsg({ fill: "red", shape: "dot", text: "Pool not initialised" });
                            }
                        } else {
                            logWarn("Input topic is empty, skipping...");
                        }
                    }
                } catch (error) {
                    logError("Error on input:", error.message || error);
                }
                finally {
                    if (done) {
                        done();
                    }
                }
            } else {
                // ignore incoming events until init complete
            }
        });

        async function enqueueStreamDataForUpload(key) {
            try {
                const stream = node.pool.getStreamByNameOrKey(key);
                const streamRecordCount = stream.getRecordCount()
                if (streamRecordCount > 0) {
                    let streamKey = key;
                    let data = stream.getAllValues();
                    let length = data.length;

                    if (length > 0) {
                        enqueuedStreamBlocks.push({ streamKey, data });
                    }
                }
            } catch (error) {
                logError("Error in Enqueue Data:", error.message || error);
            }
        }

        node.on('close', async function () {
            try {
                stopAllTimers();
                enqueuedStreamBlocks = [];
            } catch (error) {
                logError("Error in On Close:", error.message || error);
            }
        });

        // HTTP Functions------------------------------------------------------------------------------------------------------------------------------
        async function getPoolStreams(poolKey) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/streams`;
            try {
                const res = await axiosInstance.get(uri);

                if (res.status == 200) {
                    const payload = res.data;
                    return payload;
                } else {
                    const text = res.data ? JSON.stringify(res.data) : "No response";
                    logWarn("Error loading streams: ", `${res.status}: ${text} `);
                    throw res;
                }
            } catch (error) {
                logError(`Error loading streams: ${uri}`, error.message || error);
                throw error;
            }
        }

        async function postAddUpdatePool(poolName) {
            const uri = `${node.rootUrlv2}pools`;
            try {
                const res = await axiosInstance.post(uri, {
                    Poolname: poolName,
                    Public: public,
                    Virtual: virtual
                });

                if (res.status == 200) {
                    const payload = res.data;
                    return payload;
                } else {
                    const text = res.data ? JSON.stringify(res.data) : "No response";
                    logWarn("Error loading pool: ", `${res.status}: ${text} `);
                    throw res;
                }
            } catch (error) {
                logError(`Error loading pool: ${uri}`, error.message || error);
                throw error;
            }
        }

        async function postAddPoolTags(poolKey, poolTags) {
            const uri = `${node.rootUrlv3}pool/${poolKey}/tags`;
            try {
                if (poolTags.length > 0) {
                    tags = fixTags(poolTags);
                    const res = await axiosInstance.post(uri, tags);
                    if (res.status == 204 || res.status == 200) {
                        return true;
                    } else {
                        logWarn("Error pushing tags to pool: ", `${res.status}: ${text}`);
                        return false;
                    }
                }
            } catch (error) {
                logError(`Error loading pool: ${uri}`, error.message || error);
                return false
            }
        }

        async function postAddUpdateStation(poolKey, poolName) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/stations`;
            const stationName = cleanString(poolName || "1");
            try {
                const res = await axiosInstance.post(uri, JSON.stringify(stationName));
                if (res.status == 200) {
                    const payload = res.data;
                    return payload.StationID;
                } else {
                    const text = res.data ? JSON.stringify(res.data) : "No response";
                    logWarn("Error creating station: ", `${res.status}: ${text}`);
                    throw res;
                }

            } catch (error) {
                logError(`Error loading station: ${uri}`, error.message || error);
            }
        }

        async function postAddUpdateStream(poolKey, stationId, streamName, dataType) {
            const uri = `${node.rootUrlv2}pools/${poolKey}/stations/${stationId}/streams`;
            try {
                const res = await axiosInstance.post(uri, {
                    "LocalIndex": streamName,
                    "StreamName": streamName,
                    "Description": streamName,
                    "Public": public,
                    "DataType": dataType
                });
                if (res.status == 200) {
                    return res.data;

                } else {
                    const text = res.data ? JSON.stringify(res.data) : "No response";
                    logWarn("Error creating stream: ", `${res.status}: ${text}`);
                    throw res;
                }

            } catch (error) {
                logError(`Error loading stream: ${uri} streamName: ${streamName} dataType: ${dataType}`, error.message || error);
                throw error;
            }
        }

        async function postAddStreamTags(streamKey, tags) {
            const uri = `${node.rootUrlv3}stream/${streamKey}/tags`;
            try {
                if (tags && tags.length > 0) {
                    tags = fixTags(tags);
                    const res = await axiosInstance.post(uri, tags);
                    if (res.status == 204 || res.status == 200) {
                        return true;
                    } else {
                        logWarn("Error pushing tags to stream: ", `${res.status}: ${text}`);
                        return false;
                    }
                }
            } catch (error) {
                logError(`Error loading tags: ${uri}`, error.message || error);
                return false;
            }
        }

        async function postBulkStreamData(enqueuedStreamBlocks) {
            const maxConcurrentRequests = DATA_UPLOAD_CHUNK_SIZE;

            async function uploadBlock(pair) {
                let body = JSON.stringify(pair.data);
                const uri = `${node.rootUrlv2}streams/${pair.streamKey}/logs`;
                try {

                    // Check to see if any no set records in the cache for this stream
                    try {
                        if (node.fileCache.streamKeyExists(pair.streamKey)) {
                            let dataType = node.pool.getStreamByNameOrKey(pair.streamKey).getDataType();
                            if (dataType) {
                                const cachedData = await node.fileCache.retrieveData(pair.streamKey, dataType);
                                let cachedBody = JSON.stringify(cachedData);
                                const resCached = await axiosInstance.post(uri, cachedBody);
                                if (resCached.status === 200) {
                                    node.fileCache.deleteFile(pair.streamKey)
                                }
                            }
                        }
                    } catch (error) { }

                    const res = await axiosInstance.post(uri, body);
                    if (res.status === 200) {
                        return;
                    } else {
                        throw new Error(`Error uploading to api server: ${res.status}`);
                    }

                } catch (error) {
                    await node.fileCache.appendData(pair.streamKey, pair.data);
                }
            }

            try {
                const promises = [];
                for (let i = 0; i < enqueuedStreamBlocks.length; i += maxConcurrentRequests) {
                    const chunk = enqueuedStreamBlocks.slice(i, i + maxConcurrentRequests);
                    const chunkPromises = chunk.map(pair => uploadBlock(pair));
                    promises.push(...chunkPromises);
                    await Promise.all(chunkPromises);
                }
                await Promise.all(promises);
                return true;

            } catch (error) {
                logError("Error posting bulk data: ", error.message || error);
                throw error;
            } finally {
                enqueuedStreamBlocks.length = 0;
            }
        }

        // Helper Functions------------------------------------------------------------------------------------------------------------------------------
        function stopAllTimers() {
            try {
                Object.keys(timers).forEach(key => {
                    clearInterval(timers[key]);
                    delete timers[key];
                });

            } catch (error) {
                logError("Error in Stop All Timers:", error.message || error);
            }
        }
        function cleanUserInput(input) {
            if (typeof input !== 'string') {
                return '';
            }
            // Remove non-printable characters, including control characters
            return input.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        }
        function isValidApiKey(apiKey) {
            if (apiKey == null) { // Check for null or undefined
                return false;
            }
            const apiKeyRegex = /^Bitpool2 [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[4][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
            return apiKeyRegex.test(apiKey);
        }
        function isValidPoolName(poolName) {
            // Check if poolName is not null, not undefined, not empty, not just numbers, and its length is <= 255
            return poolName != null && typeof poolName === 'string' && poolName.length > 0 && poolName.length <= 255 && !/^\d+$/.test(poolName);
        }
        function fixTags(tags) {
            // Fix tags format
            for (let i = 0; i < tags.length; i++) {
                // If tag start with not alpha, add 'a' to it
                if (!/^[a-zA-Z]/.test(tags[i])) {
                    tags[i] = 'a' + tags[i];
                }
                // convert tags to camelCase
                if (tags[i].includes("=")) {
                    const parts = tags[i].split("=").map(x => x.trim());
                    tags[i] = `${camelCase(parts[0])}=${parts[1]}`;
                } else {
                    tags[i] = camelCase(tags[i].trim());
                }
            }
            return tags;
        }
        function updateStatusMsg(jsonProps) {
            node.status({ fill: jsonProps.fill, shape: jsonProps.shape, text: jsonProps.text });
        }
        function logError(param1, param2) {
            if (bpChkShowDebugWarnings) {
                if (param1) node.warn(`ERROR: ${param1}`);
                if (param2) node.warn(`${param2.response?.data ? JSON.stringify(param2.response?.data) : param2.response ? JSON.stringify(param2.response) : JSON.stringify(param2)}`);
            }
        }
        function logWarn(param1, param2) {
            if (bpChkShowDebugWarnings) {
                if (param1) node.warn(`WARNING: ${param1}`);
                if (param2) node.warn(`${param2.response?.data ? JSON.stringify(param2.response?.data) : param2.response ? JSON.stringify(param2.response) : JSON.stringify(param2)}`);
            }
        }
        function logInfo(param1) {
            if (bpChkShowDebugWarnings) {
                node.warn(`INFO: ${param1}`)
            }
        }
        function _removeNameSpacePrefix(tags) {
            for (let index = 0; index < tags.length; index++) {
                if (tags[index].includes(":")) {
                    const splitTag = tags[index].split(":")
                    tags[index] = splitTag[1];
                }
            };
            return tags;
        }
        function isValidGUID(str) {
            const guidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[4][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
            return guidRegex.test(str);
        }

        function cleanString(inputString) {
            // Remove unwanted backslashes and extra double quotes
            return inputString.replace(/["\\]/g, '');
        }
        function getRandomNumber(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        function formatDateToDdHhMmSs(seconds) {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            const formattedHours = String(hours).padStart(2, '0');
            const formattedMinutes = String(minutes).padStart(2, '0');
            const formattedSeconds = String(secs).padStart(2, '0');

            if (days > 0) {
                return `${days} ${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
            } else {
                return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
            }
        }

    };
    RED.nodes.registerType('uploader', BITPOOL);
}