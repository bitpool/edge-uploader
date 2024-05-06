/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

const { resolve } = require('path');

module.exports = function (RED) {
    const fetch = require('node-fetch');
    const https = require("https");
    const { Uploader } = require("./uploader")
    const { Log } = require("./log")
    const { ToadScheduler, SimpleIntervalJob, Task, AsyncTask } = require('toad-scheduler')
    const os = require("os");
    const { Mutex } = require("async-mutex");

    function BITPOOL(config) {
        RED.nodes.createNode(this, config);

        let nodeContext = this.context().flow;
        let apiKeyConfig = RED.nodes.getNode(config.apiKey);
        let poolSettings = RED.nodes.getNode(config.pool_settings);
        let api_key = apiKeyConfig.api_key;
        let pool_name = poolSettings.pool_name;
        let stream_name = config.stream_name;
        let public = poolSettings.public;
        let virtual = poolSettings.virtual;
        let uploadCount = config.uploadCount;
        let uploadInterval = config.uploadInterval;

        let bpChkShowDateOnLabel = config.bpChkShowDateOnLabel;
        let bpChkShowDebugWarnings = config.bpChkShowDebugWarnings;
        let rebuildOnError = config.rebuildOnError;

        let node = this;
        let toLog = false;
        let isDev = false;

        this.rootUrlv1 = isDev ? "https://dev.api.bitpool.com/rest/BitPool_V1/" : "https://api.bitpool.com/rest/BitPool_V1/";
        this.rootUrlv2 = isDev ? "https://dev.api.bitpool.com/public/v2/" : "https://api.bitpool.com/public/v2/";
        this.rootUrlv3 = isDev ? "https://dev.api.bitpool.com/public/v3/" : "https://api.bitpool.com/public/v3/";
        this.isrequesting = false;
        this.processQueue = [];
        this.uploading = false;
        this.scheduler = new ToadScheduler();
        this.mutex = new Mutex();
        this.PoolTags = config.PoolTags;

        this.uploader = nodeContext.get("uploader") || new Uploader();

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        let headers = {
            'Authorization': api_key,
            'Content-Type': "application/json"
        };

        //schedule rebuild task
        const task = new Task('simple task', () => {
            reInitialiseUploader();
        });

        //schedule rebuild every 15 mins
        const job = new SimpleIntervalJob(
            { seconds: 1200, }, 
            task, 
            {
                id: 'reInitialiseUploader'
            }
        );
        this.scheduler.addSimpleIntervalJob(job);


        //schedule checkState task
        const checkStateTask = new AsyncTask('simple task',
            () => {
                // https://www.npmjs.com/package/toad-scheduler
                // Usage with async tasks
                // Note that in order to avoid memory leaks, it is recommended to use promise chains instead of async/await inside task definition. 
                return checkState().then((result) => { /* nothing */ })
            },
            (err) => { /* ignore */ }
        );

        //schedule checkState
        const checkStateJob = new SimpleIntervalJob(
            { seconds: 1, },
            checkStateTask,
            {
                id: 'checkState',
                preventOverrun: true // prevent second instance of a task from being fired up while first one is still executing
            }
        );
        this.scheduler.addSimpleIntervalJob(checkStateJob);

        //Main function that occurs on node input
        node.on('input', function (msg, send, done) {
            try {
                if (msg.BPCommand == "REBUILD") {
                    //triggers object rebuild. 
                    reInitialiseUploader();
                } else {
                    if (node.PoolTags) msg.PoolTags = node.PoolTags;

                    //get tags from msg object
                    let streamTags = msg.meta ? msg.meta : null;
                    let poolTags = msg.PoolTags ? msg.PoolTags : null;

                    //format tags 
                    if (streamTags && streamTags !== "") {
                        if (streamTags.includes(",")) {
                            streamTags = streamTags.split(", ");
                        } else {
                            streamTags = [streamTags]
                        }
                        streamTags = removeNameSpacePrefix(streamTags);
                    }

                    //format tags
                    if (poolTags && poolTags !== "") {
                        if (poolTags.includes(",")) {
                            poolTags = poolTags.split(", ");
                        } else {
                            poolTags = [poolTags];
                        }
                        poolTags = poolTags.concat([`operatingSystem=${os.version()}`, `nodejsVersion=${process.version}`, `nodeRedVersion=${RED.version()}`])
                    } else {
                        poolTags = [`operatingSystem=${os.version()}`, `nodejsVersion=${process.version}`, `nodeRedVersion=${RED.version()}`];
                    }

                    poolTags = removeNameSpacePrefix(poolTags);

                    //set pending status
                    applyStatus({ fill: "blue", shape: "dot", text: "Processing " + new Date().toLocaleString() });

                    let poolBody = {
                        "Poolname": "",
                        "Public": public,
                        "Virtual": virtual
                    };

                    //set pool name, from msg.pool or uploader setting
                    let poolName;
                    if (msg.pool && msg.pool !== "") {
                        poolBody.Poolname = msg.pool;
                        poolName = msg.pool;
                    } else {
                        poolBody.Poolname = pool_name;
                        poolName = pool_name;
                    }

                    //set stream name, from msg.topic or uploader setting
                    let streamName;
                    if (msg.topic && msg.topic !== "") {
                        streamName = msg.topic
                    } else if (msg.stream && msg.stream !== "") {
                        streamName = msg.stream;
                    } else {
                        streamName = stream_name;
                    }

                    //get msg.payload data type
                    let dataType = getDataType(msg.payload);

                    const now = new Date();

                    //object to be used in bulk upload
                    let valueObj;

                    //Support for different data types
                    if (dataType === "Double") {
                        valueObj = {
                            "Ts": now.toISOString(),
                            "Val": msg.payload,
                            "ValStr": null,
                            "Calculated": false
                        };
                    } else if (dataType === "String") {
                        valueObj = {
                            "Ts": now.toISOString(),
                            "Val": null,
                            "ValStr": msg.payload,
                            "Calculated": false
                        };
                    }

                    //only add to queue if valueObj has been assigned - String and Double types only
                    if (valueObj && poolName && streamName) {
                        this.uploader.addToQueue(poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType);
                        applyStatus({ fill: "blue", shape: "dot", text: "Message in queue " + new Date().toLocaleString() });
                    }
                }
            } catch (e) {
                logOut("Unable to handle input", e);
                applyStatus({ fill: "red", shape: "dot", text: "Unable to handle input" });
            }
            // Once finished, call 'done'.
            // This call is wrapped in a check that 'done' exists
            // so the node will work in earlier versions of Node-RED (<1.0)
            if (done) {
                done();
            }
        });

        node.on('close', function () {
            nodeContext.set("uploader", this.uploader);

            //remove jobs on deploy to avoid memory leaks
            node.scheduler.removeById("checkState");
            node.scheduler.removeById("reInitialiseUploader");
        });

        async function checkState() {
            let release = await node.mutex.acquire();

            try {
                const queue = node.uploader.getQueueAndClean();
                if (queue.length) {
                    for (let item of queue) {
                        try {
                            await buildStructure(item.poolBody, item.poolName, item.streamName, item.poolTags, item.streamTags, item.valueObj, item.dataType);
                        } catch (e) {
                            logOut("Unable to set up pools or streams", e);
                            applyStatus({ fill: "red", shape: "dot", text: "Unable to set up pools or streams" });
                        }
                    }
                }

                let timeDiff = (Math.floor(Date.now() / 1000) - node.uploader.getUploadTs());

                let count = node.uploader.getLogCount();

                if (count >= uploadCount || timeDiff >= uploadInterval && node.uploading == false) {
                    //Wait for uploadCount setting to be met, OR, uploadInterval time to pass

                    node.uploading = true;

                    let uploadData = node.uploader.getBulkUploadData();

                    if (uploadData.length > 0) {
                        try {
                            let uploadResult = await pushBulkUploadData(uploadData);
                            if (uploadResult !== false) {
                                applyStatus({ fill: "green", shape: "dot", text: new Date().toLocaleString() });
                                node.uploader.clearUploadedValues(count);
                            } else {
                                applyStatus({ fill: "red", shape: "dot", text: "Unable to push to Bitpool " });
                                if (rebuildOnError) {
                                    await reInitialiseUploader();
                                }
                            }
                        } catch (e) {
                            applyStatus({ fill: "red", shape: "dot", text: "Unable to push to Bitpool " });
                            if (rebuildOnError) {
                                await reInitialiseUploader();
                            }
                        } finally {
                            node.uploading = false;
                        }
                    } else {
                        node.uploading = false;
                    }
                } else {
                    //set pending status
                    applyStatus({ fill: "blue", shape: "dot", text: count + " Logs Cached" });
                }
            } catch (e) {
                logOut("Error in checkState", e);
            }finally {
                release();
            }
        }

        function reInitialiseUploader() {
            node.uploader = new Uploader();
            logOut("Uploader Rebuilt");
            nodeContext.set("uploader", node.uploader);

            //remove jobs on deploy to avoid memory leaks
            node.scheduler.removeById("checkState");
            node.scheduler.removeById("reInitialiseUploader");

            //re add jobs
            node.scheduler.addSimpleIntervalJob(job);
            node.scheduler.addSimpleIntervalJob(checkStateJob);

            applyStatus({});
        }

        async function buildStructure(poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType) {
            //check if log exists in cache
            let logExists = node.uploader.getLog(poolName, streamName) === undefined ? false : true;

            if (!logExists) {

                // Log doesnt exist in cache, handle the creation of new log. 
                // Check api for pool, create a new pool if not found
                // Check api for stream, create a new station and stream within pool if not found

                let poolExists = node.uploader.getPool(poolName) === undefined ? false : true;

                let poolObj;
                let poolKey;
                let streamObj;

                if (!poolExists) {
                    poolObj = await setUpPool(poolBody);

                    poolKey = poolObj.PoolKey;

                    // add pool to cache
                    node.uploader.addPool({ poolName: poolName, PoolKey: poolKey });

                    let poolTagsChanged = node.uploader.getPoolTagsChanged(poolKey, poolTags);

                    if (poolTagsChanged) {
                        await addTagsToPool(poolKey, poolTags);
                        node.uploader.updatePoolTags(poolKey, poolTags);
                    }

                    streamObj = await setupStreams(poolObj, poolKey, streamName, dataType);

                    let streamKey = streamObj.StreamKey;

                    let streamTagsChanged = node.uploader.getStreamTagsChanged(streamKey, streamTags);

                    if (streamTagsChanged) {
                        await addTagsToStream(streamKey, streamTags);
                        node.uploader.updateStreamTags(streamKey, streamTags);
                    }

                    // create new log
                    let log = new Log(poolName, streamName, poolTags, streamTags, poolKey, streamKey, valueObj);

                    // add to cache 
                    node.uploader.addToLogs(log);
                    return log;
                } else {

                    poolObj = node.uploader.getPool(poolName);
                    poolKey = poolObj.PoolKey;

                    streamObj = await setupStreams(poolObj, poolKey, streamName, dataType);

                    let streamKey = streamObj.StreamKey;

                    let streamTagsChanged = node.uploader.getStreamTagsChanged(streamKey, streamTags);

                    if (streamTagsChanged) {
                        await addTagsToStream(streamKey, streamTags);
                        node.uploader.updateStreamTags(streamKey, streamTags);
                    }

                    // create new log
                    let log = new Log(poolName, streamName, poolTags, streamTags, poolKey, streamKey, valueObj);

                    // add to cache 
                    node.uploader.addToLogs(log);

                    return log;
                }

            } else {
                // Log exists in cache, update with new value object

                let foundLog = node.uploader.getLog(poolName, streamName);

                node.uploader.updateLog(foundLog, valueObj);

                let poolTagsChanged = node.uploader.getPoolTagsChanged(foundLog.poolkey, poolTags);

                //update pool tags if changed
                if (poolTagsChanged) {
                    await addTagsToPool(foundLog.poolkey, poolTags);
                    node.uploader.updatePoolTags(foundLog.poolkey, poolTags);
                }

                let streamTagsChanged = node.uploader.getStreamTagsChanged(foundLog.streamKey, streamTags);

                //update stream tags if changed
                if (streamTagsChanged) {
                    await addTagsToStream(foundLog.streamKey, streamTags);
                    node.uploader.updateStreamTags(foundLog.streamKey, streamTags);
                }

                return foundLog;
            }
        };

        async function setUpPool(poolBody) {
            const poolObj = await createOrGetPool(poolBody);
            node.uploader.addToPoolTags(poolBody, poolObj);
            return poolObj;
        }

        async function setupStreams(poolObj, poolKey, streamName, dataType) {
            if (typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null &&
                typeof streamName !== 'undefined' && streamName !== "" && streamName !== null
            ) {
                const streamObj = await createOrGetStream(poolObj, streamName, dataType);
                node.uploader.addToStreamTags(streamObj);
                return streamObj;
            } else {
                throw new Error("Unable to create Stream. Check settings.");
            }
        }

        //creates a new pool
        async function createOrGetPool(body) {
            applyStatus({ fill: "blue", shape: "dot", text: "Loading Pool" });

            try {
                const res = await fetch(node.rootUrlv2 + "pools", { method: 'POST', headers: headers, agent: agent, body: JSON.stringify(body) });
                if (res.status == 200) {
                    const payload = await res.json();
                    payload.Tags = await loadTagsPool(payload.PoolKey);
                    return payload;
                } else {
                    const text = await res.text();
                    logOut("Unable to load pool, response: ", `${res.status}: ${text}`);
                    throw res;
                }
            } catch (error) {
                logOut("Unable to load pool: ", error);
                applyStatus({ fill: "red", shape: "dot", text: "Error loading pool" });
                throw error;
            }
        }

        //Load pool tags
        async function loadTagsPool(poolKey) {
            applyStatus({ fill: "blue", shape: "dot", text: "Loading Pool Tags" });

            try {
                const res = await fetch(`${node.rootUrlv3}pool/${poolKey}/tags`, { method: 'GET', headers: headers, agent: agent });
                if (res.status == 200) {
                    const payload = await res.json();
                    return payload;
                } else {
                    const text = await res.text();
                    logOut("Unable to load pool tags, response: ", `${res.status}: ${text}`);
                    throw res;
                }
            } catch (error) {
                logOut("Unable to load pool tags: ", error);
                applyStatus({ fill: "red", shape: "dot", text: "Error loading pool tags" });
                throw error;
            }
        }

        //creates a new station in provided pool
        async function createOrGetStation(poolKey, pool) {
            applyStatus({ fill: "blue", shape: "dot", text: "Loading station" });

            const stationName = pool.Name || pool.poolName || "1";

            const stationExists = node.uploader.getStation(poolKey);

            if (!stationExists) {
                try {
                    const res = await fetch(node.rootUrlv2 + `pools/${poolKey}/stations`, { method: 'POST', headers: headers, agent: agent, body: JSON.stringify(stationName) });
                    if (res.status == 200) {
                        const payload = await res.json();
                        const result = { poolKey: poolKey, StationID: payload.StationID };
                        node.uploader.addStation(result);
                        return result;
                    } else {
                        const text = await res.text();
                        logOut("Unable to create station, response: ", `${res.status}: ${text}`);
                        applyStatus({ fill: "blue", shape: "dot", text: "Error loading station. Error: " + res.status });
                        throw res;
                    }
                } catch (error) {
                    logOut("Unable to loading station: ", error);
                    applyStatus({ fill: "blue", shape: "dot", text: "Error loading station " });
                    throw error;
                }
            } else {
                return stationExists;
            }
        }

        //checks/creates station in pool, then creates stream for 1ST station. 
        async function createOrGetStream(pool, streamName, dataType) {
            let poolKey = pool.PoolKey;

            applyStatus({ fill: "blue", shape: "dot", text: "Loading Stream" });

            try {
                if (typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null) {
                    const station = await createOrGetStation(poolKey, pool);
                    let streamBody = {
                        "LocalIndex": streamName,
                        "StreamName": streamName,
                        "Description": streamName,
                        "Public": public,
                        "DataType": dataType
                    };
                    const res = await fetch(node.rootUrlv2 + `pools/${poolKey}/stations/${station.StationID}/streams`, { method: 'POST', headers: headers, agent: agent, body: JSON.stringify(streamBody) });

                    if (res.status == 200) {
                        const payload = await res.json();
                        payload.Tags = await loadTagsStream(payload.StreamKey);
                        return payload;
                    } else {
                        const text = await res.text();
                        logOut("Unable to load stream, response: ", `${res.status}: ${text}`);
                        applyStatus({ fill: "red", shape: "dot", text: "Error loading Stream. Error: " + res.status });
                        throw res;
                    }

                }
            } catch (error) {
                logOut(error);
                applyStatus({ fill: "red", shape: "dot", text: "Error loading Stream" });
                throw error;
            }
        }

        //Load stream tags
        async function loadTagsStream(streamKey) {
            applyStatus({ fill: "blue", shape: "dot", text: "Loading Stream Tags" });

            try {
                const res = await fetch(`${node.rootUrlv3}stream/${streamKey}/tags`, { method: 'GET', headers: headers, agent: agent });
                if (res.status == 200) {
                    const payload = await res.json();
                    return payload;
                } else {
                    const text = await res.text();
                    logOut("Unable to load stream tags, response: ", `${res.status}: ${text}`);
                    throw res;
                }
            } catch (error) {
                logOut("Unable to load stream tags: ", error);
                applyStatus({ fill: "red", shape: "dot", text: "Error loading stream tags" });
                throw error;
            }
        }

        //uploads bulk data to cloud
        async function pushBulkUploadData(uploadData) {
            applyStatus({ fill: "blue", shape: "dot", text: "Pushing to Bitpool" });
            let body = JSON.stringify(uploadData);
            try {
                const res = await fetch(node.rootUrlv2 + "streams/logs", { method: 'POST', headers: headers, agent: agent, body: body });
                if (res.status == 200) {
                    return true;
                } else {
                    const text = await res.text();
                    logOut("Unable to upload to bitpool, response: ", `${res.status}: ${text}`);
                    return false;
                }
            } catch (error) {
                logOut("Unable to upload to bitpool: ", error);
                throw error;
            }
        }

        async function addTagsToStream(streamKey, tags) {
            //push tags to stream
            if (tags && tags !== "" && tags.length > 0 && streamKey) {
                let newTagResult = await pushNewTagsToStream(streamKey, tags);
            }
        }

        async function addTagsToPool(poolKey, tags) {
            //push tags to pool
            if (tags && tags !== "" && tags.length > 0 && poolKey) {
                let newTagResult = await pushNewTagsToPool(poolKey, tags);
            }
        }

        //Inserts specified tags to current stream
        async function pushNewTagsToStream(streamKey, tags) {
            applyStatus({ fill: "blue", shape: "dot", text: "Pushing tags to stream" });
            if (typeof streamKey !== 'undefined' && streamKey !== "" && streamKey !== null && tags) {
                const res = await fetch(node.rootUrlv3 + `stream/${streamKey}/tags`, { method: 'POST', headers: headers, agent: agent, body: JSON.stringify(tags) });
                //returns true if sucessfully added tags
                if (res.status == 204 || res.status == 200) {
                    return true;
                } else {
                    applyStatus({ fill: "red", shape: "dot", text: "Error pushing tags to stream. Error: " + res.status });
                    return false;
                }
            } else {
                return false;
            }
        }

        //Inserts specified tags to current pool
        async function pushNewTagsToPool(poolKey, tags) {
            applyStatus({ fill: "blue", shape: "dot", text: "Pushing tags to pool" });
            if (typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null && tags) {
                const res = await fetch(node.rootUrlv3 + `pool/${poolKey}/tags`, { method: 'POST', headers: headers, agent: agent, body: JSON.stringify(tags) });
                //returns true if sucessfully added tags
                if (res.status == 204 || res.status == 200) {
                    return true;
                } else {
                    applyStatus({ fill: "red", shape: "dot", text: "Error pushing tags to pool. Error: " + res.status });
                    return false;
                }
            } else {
                return false;
            }
        }

        //Returns msg.payload data type - either Double or String as per bitpool api - 
        function getDataType(value) {
            let toType = function (obj) {
                return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
            };
            let type = toType(value);
            if (value.constructor === ({}).constructor) {
                return "JSONObject"
            } else if (isJsonString(value) == true) {
                return "JSONObject"
            } else if (value == 0 && typeof value == "number") {
                return "Double"
            } else if (value == "") {
                return "Empty"
            } else if (value == null || value == undefined || value == 'undefined') {
                return "Null"
            } else {
                switch (type) {
                    case "boolean":
                        return "String"
                        break;
                    case "number":
                        return "Double"
                        break;
                    case "string":
                        return "String";
                        break;
                }
            }
        }

        function removeNameSpacePrefix(tags) {
            for (let index = 0; index < tags.length; index++) {
                if (tags[index].includes(":")) {
                    const splitTag = tags[index].split(":")
                    tags[index] = splitTag[1];
                }
            };
            return tags;
        }

        function isJsonString(strData) {
            try {
                let obj = JSON.parse(strData);
                let keys = Object.keys(obj);
                if (keys.length > 0) {
                    return true;
                } else {
                    return false;
                }
            } catch (e) {
                return false;
            }
        }

        function applyStatus(jsonProps) {
            if (bpChkShowDateOnLabel) {
                node.status(jsonProps)
            }
        }

        function logOut(param1, param2) {
            if (bpChkShowDebugWarnings) {
                if (param1) node.warn(param1);
                if (param2) node.warn(JSON.stringify(param2));
            }
        }
    };
    RED.nodes.registerType('uploader', BITPOOL);
}
