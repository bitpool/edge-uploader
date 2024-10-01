/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/


module.exports = function (RED) {
    const axios = require('axios');
    const { Pool } = require("./uploader")
    const os = require("os");
    const { Mutex } = require("async-mutex");
    const camelCase = require('camelcase');
    const fs = require('fs');
    const zlib = require('zlib');
    const util = require('util');
    const gunzip = util.promisify(zlib.gunzip);
    const { Agent } = require('https');

    const HTTP_TIMEOUT_SECS = 10;                   // Default HTTP session timeout in seconds
    const HTTP_FAILURE_RETRY_COUNT = 1;             // Number of retries on HTTP call failure
    const HTTP_FAILURE_RETRY_DELAY_SECS = 5;        // Delay between retries in seconds for HTTP calls
    const DATA_UPLOAD_INTERVAL_SECS = 60;           // Interval in seconds to check for data upload (default, configurable by user)
    const DATA_UPLOAD_COUNT = 4;                    // Threshold for record count to trigger data upload (default, configurable by user)
    const DATA_UPLOAD_CHUNK_SIZE = 10;              // Number of records to upload in a single batch
    const ON_INIT_UPLOAD_DATA_AFTER_SECS = 60;      // Delay in seconds to upload data after a restart    

    const MEMORY_FILE_PATH_COMPRESSED = 'upload-config.json.gz';
    const APP_POLL_UI_SECS = 1;
    const APP_POLL_ENQUEUE_SECS = 1;
    const APP_POLL_DEQUEUE_SECS = 2;

    function BITPOOL(config) {
        RED.nodes.createNode(this, config);

        // Config options for Bitpool API
        let apiKeyConfig = RED.nodes.getNode(config.apiKey);
        let poolSettings = RED.nodes.getNode(config.pool_settings);
        let api_key = apiKeyConfig.api_key || "";
        let pool_name = poolSettings.pool_name || "";
        let public = poolSettings.public || false;
        let virtual = poolSettings.virtual || false;

        // Config options for status monitoring
        let uploadCount = Number(config.uploadCountV2 || DATA_UPLOAD_COUNT);
        let timeoutSecs = Number(config.timeout || HTTP_TIMEOUT_SECS);
        let uploadIntervalSecs = Number(config.uploadInterval || DATA_UPLOAD_INTERVAL_SECS);
        let bpChkShowDebugWarnings = config.bpChkShowDebugWarnings;

        // Timers
        let timerCheckUI = null;
        let timerEnqueue = null;
        let timerDequeue = null;
        let enqueuedStreamBlocks = [];
        let configFileName = `${pool_name}-${MEMORY_FILE_PATH_COMPRESSED}`.toLowerCase().replace(/[^a-z0-9.]/g, '-');

        // Runtime variables
        const timers = {};
        this.mutex = new Mutex();
        this.pool = new Pool();
        this.rootUrlv2 = "https://api.bitpool.com/public/v2/";
        this.rootUrlv3 = "https://api.bitpool.com/public/v3/";
        this.initComplete = true;
        this.PoolTags = config.PoolTags;
        this.lastUploadCheckTimeUI = new Date();
        this.lastUploadCheckTimeEnqueue = new Date();
        this.avgCountRecordsForAllStreams = 0

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
            let release = await node.mutex.acquire();
            let doOnNewPoolCreation = true;

            // Ensure all previous timers are stopped
            try {
                stopAllTimers();
            } catch (error) {
                logError("Error stopping timers:", error.message || error);
            }

            try {
                // If the configuration file does not exist, create it and save the default pool state
                if (!fs.existsSync(configFileName)) {
                    fs.writeFileSync(configFileName, '');
                    await savePoolState();
                }

                try {
                    const compressedData = fs.readFileSync(configFileName);
                    const decompressed = await gunzip(compressedData);
                    const restoredObject = JSON.parse(decompressed.toString());
                    node.pool = Pool.fromJSON(restoredObject);

                } catch (error) { }

                updateStatusMsg({ fill: "green", shape: "dot", text: "Pool restored OK" });

                // If the pool name has not changed, upload data
                // This will happen when the user changes the config and publishes
                if (pool_name == node.pool.getPoolName()) {
                    try {
                        let streams = node.pool.getStreamKeyList();
                        setTimeout(async () => {
                            for (let index = 0; index < streams.length; index++) {
                                const streamKey = streams[index];
                                const stream = node.pool.getStreamByNameOrKey(streamKey);
                                if (stream && stream.streamKey && stream.streamName) {
                                    await enqueueStreamDataForUpload(stream.streamKey, stream.streamName);
                                }
                            }
                        }, ON_INIT_UPLOAD_DATA_AFTER_SECS * 1000);
                    } catch (error) {
                        logError('Not found stored pool state, will configure using defaults.', error || error.message);
                    }
                    doOnNewPoolCreation = false;
                }

            } catch (error) {
                logError('Did not find stored pool state, will configure using defaults.');
            }

            try {
                // Send the pool configuration to the debug window on startup                
                node.send({
                    "payload": {
                        "config": {
                            "api_key": apiKeyConfig.api_key,
                            "pool_name": pool_name,
                            "upload_on_record_count": uploadCount,
                            "upload_on_expired_secs": uploadIntervalSecs,
                            "http_timeout_secs": timeoutSecs,
                            "option_show_debug_warnings": bpChkShowDebugWarnings,
                        }
                    }
                });
            } catch (error) {
                logError('Failed to load configuration state.', error || error.message);
            }

            if (doOnNewPoolCreation) {
                try {
                    // Wait for the system to load, then set up the pool and station with tags
                    setTimeout(async () => {
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

                            await savePoolState();
                            updateStatusMsg({ fill: "green", shape: "dot", text: "Pool initialised OK" });

                            node.initComplete = true;
                        } else {
                            logWarn("Error initializing:", error.message || error);
                            node.status({ fill: "red", shape: "ring", text: "Error initializing" });
                        }

                    }, 1);
                } catch (error) {
                    logError("Error initializing:", error.message || error);
                    node.status({ fill: "red", shape: "ring", text: "Error initializing" });
                }
            }

            // Send the pool object to the debug window on startup 
            node.send({
                "payload": {
                    "pool": node.pool
                }
            });

            // Set up timer to update the UI
            clearInterval(timerCheckUI);
            if (timerCheckUI === null) {
                timers.uiTimer = setInterval(async () => {
                    try {
                        const streamCount = node.pool.getStreamCount();
                        const totalPoolRecordCount = node.pool.getCountOfAllRecords();
                        const avgRecordsPerStream = Math.floor(totalPoolRecordCount / streamCount) || 0;
                        node.avgCountRecordsForAllStreams = avgRecordsPerStream;

                        const now = new Date();
                        const elapsedSeconds = Math.floor((now - node.lastUploadCheckTimeUI) / 1000);
                        const remainingSeconds = uploadIntervalSecs - elapsedSeconds;

                        if (remainingSeconds < 0) {
                            node.lastUploadCheckTimeUI = now;

                        } else {
                            const formattedTime = formatDateToDdHhMmSs(remainingSeconds);
                            const message = `In:(${totalPoolRecordCount}) Out:(${enqueuedStreamBlocks.length}) Limit:(${avgRecordsPerStream}/${uploadCount}) Time:(${formattedTime})`;
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

                    if (remainingSeconds < 0) {
                        await pushDataToUploadQueue(true);
                        node.lastUploadCheckTimeEnqueue = now;

                    }
                    if (node.avgCountRecordsForAllStreams >= uploadCount) {
                        if (node.pool.getCountOfAllRecords() >= node.avgCountRecordsForAllStreams) {
                            await pushDataToUploadQueue(false);
                        }
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

            release();
        }

        // Initialize the node to build the pool and station
        initializeNode();

        async function pushDataToUploadQueue(purge = false) {
            try {
                let streams = node.pool.getStreamKeyList();

                for (let index = 0; index < streams.length; index++) {
                    const streamKey = streams[index];
                    const stream = node.pool.getStreamByNameOrKey(streamKey);
                    const streamName = stream.getStreamName();

                    if (purge) {
                        await enqueueStreamDataForUpload(streamKey, streamName);
                    } else {
                        const streamRecordCount = stream.getRecordCount();
                        if (streamRecordCount >= uploadCount) {
                            await enqueueStreamDataForUpload(streamKey, streamName);
                        }
                    }
                }
            } catch (error) {
                logError("Error in Timer:", error.message || error);
            }
        }

        async function uploadQueuedDataNow(purge = false) {
            try {
                if (enqueuedStreamBlocks.length > 0 || purge) {
                    try {
                        const maxNumberOfStreamsPerBulkPost = DATA_UPLOAD_CHUNK_SIZE;
                        while (enqueuedStreamBlocks.length > 0) {
                            const chunk = enqueuedStreamBlocks.splice(0, maxNumberOfStreamsPerBulkPost);
                            const result = await postBulkStreamData(chunk);
                            if (!result) {
                                logWarn(`Failed to upload stream data`);
                            }
                        }
                        enqueuedStreamBlocks = [];
                    } catch (error) {
                        logError('Bulk data upload failed:', error.message || error);
                    }
                }

            } catch (error) {
                logError("Error in Timer:", error.message || error);
            }
        }

        node.on('input', async function (msg, send, done) {
            let release = await node.mutex.acquire();
            try {
                if (msg.BPCommand == "REBUILD") {
                    logInfo("The command REBUILD is no longer supported (use CREATE_CONFIG). Note, CREATE_CONFIG will delete all exsiting configuration data.")

                } else if (msg.BPCommand == "SHOW_CONFIG") {    // ----------------------------------------------
                    send({
                        "payload": {
                            "config": {
                                "api_key": apiKeyConfig.api_key,
                                "pool_name": pool_name,
                                "upload_on_record_count": uploadCount,
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

                } else if (msg.BPCommand == "CREATE_POOL") {    // ----------------------------------------------
                    this.pool = new Pool();
                    if (fs.existsSync(configFileName)) {
                        fs.unlinkSync(configFileName);
                    }
                    release();
                    initializeNode();
                    const poolName = node.pool.getPoolName();
                    if (poolName) {
                        logInfo(`Rebuilt the pool (${poolName}) model for this node.`);
                    } else {
                        logInfo(`Rebuilt default model for this node.`);
                    }

                } else if (msg.BPCommand == "SAVE_POOL") {      // ----------------------------------------------
                    await savePoolState();
                    logInfo(`Saved the pool (${node.pool.getPoolName()}) model for this node.`);

                } else if (msg.BPCommand == "PURGE_DATA") {     // ----------------------------------------------
                    node.pool.purgeRecordsOnly();
                    logInfo(`Purged all record data stored on this pool (${node.pool.getPoolName()}) node.`);


                } else if (msg.BPCommand == "UPLOAD_DATA") {    // ----------------------------------------------
                    try {
                        await pushDataToUploadQueue(true);
                        await uploadQueuedDataNow(true);
                        logInfo(`Uploaded all record data stored on this pool (${node.pool.getPoolName()}) node.`);

                    } catch (error) {
                        logError('Did not find stored pool configuration, will configure using defaults.', error || error.message);
                    }

                } else {
                    if (msg.topic && msg.topic.trim() !== "") {
                        if (this.initComplete) {
                            let streamName = msg.topic;

                            node.pool.addStreamName(streamName);

                            // Critical - Add data first to determine the data type, which is required by the stream add function                            
                            node.pool.stream(streamName).addData(msg.payload);
                            let streamKey = node.pool.getStreamByNameOrKey(streamName).getStreamKey();

                            if (!streamKey) {
                                let poolKey = node.pool.getPoolKey();
                                let stationId = node.pool.getStationId();
                                let dataType = node.pool.getStreamByNameOrKey(streamName).getDataType();
                                let stream = await postAddUpdateStream(poolKey, stationId, streamName, dataType);

                                node.pool.updateStreamKey(streamName, stream.StreamKey);

                                let streamTags = msg.meta?.split(/\s*,\s*/) || null;
                                if (streamTags) {
                                    streamTags = _removeNameSpacePrefix(streamTags);
                                    streamTags = [...new Set(streamTags)];
                                }

                                node.pool.stream(streamName).updateTags(streamTags);
                                await postAddStreamTags(stream.StreamKey, streamTags)
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
                release();
                if (done) {
                    done();
                }
            }
        });

        async function enqueueStreamDataForUpload(key, value) {
            try {
                const stream = node.pool.getStreamByNameOrKey(key);
                const streamRecordCount = stream.getRecordCount()
                if (streamRecordCount > 0) {
                    let streamKey = key;
                    let streamName = value;
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
                await savePoolState();
                stopAllTimers();
            } catch (error) {
                logError("Error in On Close:", error.message || error);
            }
        });

        async function savePoolState() {
            try {
                zlib.gzip(Buffer.from(JSON.stringify(node.pool), 'utf8'), (error, compressed) => {
                    if (error) {
                        logError("Error during file compression:", error.message || error);
                    } else {
                        try {
                            fs.writeFileSync(configFileName, compressed);
                        } catch (error) {
                            logError("Error during saving file:", error.message || error);
                        }
                    }
                });
            } catch (error) {
                logError("Error during svaing the pool state:", error.message || error);
            }
        }


        // HTTP Functions------------------------------------------------------------------------------------------------------------------------------
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
            const retryCount = HTTP_FAILURE_RETRY_COUNT;
            const retryDelay = HTTP_FAILURE_RETRY_DELAY_SECS * 1000;
            const maxConcurrentRequests = DATA_UPLOAD_CHUNK_SIZE;

            async function uploadWithRetry(pair, retries) {
                let body = JSON.stringify(pair.data);
                let attempt = 0;
                while (attempt < retries) {
                    const uri = `${node.rootUrlv2}streams/${pair.streamKey}/logs`;
                    try {
                        const res = await axiosInstance.post(uri, body);
                        if (res.status === 200) {
                            return true;
                        } else {
                            const text = res.data ? JSON.stringify(res.data) : "No response";
                            logWarn("Error uploading to server: ", `${res.status}: ${text}`);
                            throw new Error(`Error uploading to api server: ${res.status}`);
                        }
                    } catch (error) {

                        logError(`Error uploading to the server: ${uri}`, error.message || error);
                        attempt++;
                        if (attempt < retries) {
                            const backoffDelay = retryDelay * Math.pow(2, attempt); // Exponential backoff
                            logWarn(`Retrying in ${backoffDelay / 1000} seconds.`);
                            await new Promise(resolve => setTimeout(resolve, backoffDelay));
                        } else {
                            logWarn(`Max retries reached. Uploading failed: ${uri}`);
                            throw error;
                        }
                    }
                }
            }

            try {
                const promises = [];
                for (let i = 0; i < enqueuedStreamBlocks.length; i += maxConcurrentRequests) {
                    const chunk = enqueuedStreamBlocks.slice(i, i + maxConcurrentRequests);
                    const chunkPromises = chunk.map(pair => uploadWithRetry(pair, retryCount));
                    promises.push(...chunkPromises);
                    await Promise.all(chunkPromises); // Wait for the current batch to complete
                }
                await Promise.all(promises);
                return true;
            } catch (error) {
                logError("Error posting bulk data: ", error.message || error);
                throw error;
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
            node.warn(`INFO: ${param1}`)
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