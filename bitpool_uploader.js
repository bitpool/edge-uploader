/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/

const { resolve } = require('path');

module.exports = function(RED) {
    const fetch = require('node-fetch');
    const https = require("https");
    const { Uploader } = require("./uploader")
    const { Log } = require("./log")
    const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler')
    const os = require("os");
    const {Mutex, Semaphore, withTimeout} = require("async-mutex");

    function BITPOOL(config) {
        RED.nodes.createNode(this,config);

        let nodeContext = this.context().flow;
        let apiKeyConfig = RED.nodes.getNode(config.apiKey);
        let poolSettings = RED.nodes.getNode(config.pool_settings);
        let api_key                  = apiKeyConfig.api_key;
        let pool_name                = poolSettings.pool_name;
        let stream_name              = config.stream_name;
        let public                   = poolSettings.public;
        let virtual                  = poolSettings.virtual;
        let uploadCount              = config.uploadCount;
        let uploadInterval           = config.uploadInterval;

        let bpChkShowDateOnLabel     = config.bpChkShowDateOnLabel;
        let bpChkShowDebugWarnings   = config.bpChkShowDebugWarnings;
        let rebuildOnError           = config.rebuildOnError;

        let node                     = this;
        let toLog                    = false;
        let isDev                    = false;

        this.rootUrlv1               = isDev ? "https://dev.api.bitpool.com/rest/BitPool_V1/" : "https://api.bitpool.com/rest/BitPool_V1/";
        this.rootUrlv2               = isDev ? "https://dev.api.bitpool.com/public/v2/" : "https://api.bitpool.com/public/v2/";
        this.rootUrlv3               = isDev ? "https://dev.api.bitpool.com/public/v3/" : "https://api.bitpool.com/public/v3/";
        this.isrequesting            = false;
        this.processQueue            = [];
        this.uploading               = false;
        this.scheduler               = new ToadScheduler();
        this.mutex                   = new Mutex();
        this.PoolTags                = config.PoolTags;

        this.uploader = nodeContext.get("uploader") || new Uploader();

        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        let headers = {
            'Authorization': api_key,
            'Content-Type' : "application/json"
        };

        //schedule rebuild task
        const task = new Task('simple task', () => { 
            reInitialiseUploader();
        });

        //schedule rebuild every 15 mins
        const job = new SimpleIntervalJob({ seconds: 1200, }, task, 'reInitialiseUploader')
        this.scheduler.addSimpleIntervalJob(job);


        //schedule checkState task
        const checkStateTask = new Task('simple task', () => { 
            checkState();
        });

        //schedule checkState
        const checkStateJob = new SimpleIntervalJob({ seconds: 1, }, checkStateTask, 'checkState')
        this.scheduler.addSimpleIntervalJob(checkStateJob);

        //Main function that occurs on node input
        node.on('input', function(msg, send, done) {

            if(msg.BPCommand == "REBUILD") {
                //triggers object rebuild. 
                reInitialiseUploader();

            } else {

                if(node.PoolTags) msg.PoolTags = node.PoolTags;
                
                //get tags from msg object
                let streamTags = msg.meta ? msg.meta : null;
                let poolTags = msg.PoolTags ? msg.PoolTags : null;

                //format tags 
                if(streamTags && streamTags !== "") {
                    if(streamTags.includes(",")){
                        streamTags = streamTags.split(", ");
                    } else {
                        streamTags = [streamTags]
                    }
                }

                //format tags
                if(poolTags && poolTags !== "") {
                    if(poolTags.includes(",")) {
                        poolTags = poolTags.split(", ");
                    } else {
                        poolTags = [poolTags];
                    }
                    poolTags = poolTags.concat([`bp:operatingSystem=${os.version()}`, `bp:nodejsVersion=${process.version}`, `bp:nodeRedVersion=${RED.version()}`])
                } else {
                    poolTags = [`bp:operatingSystem=${os.version()}`, `bp:nodejsVersion=${process.version}`, `bp:nodeRedVersion=${RED.version()}`];
                }

                //set pending status
                applyStatus({fill:"blue",shape:"dot",text:"Processing " + new Date().toLocaleString()});

                let poolBody = {
                    "Poolname": "",
                    "Public": public,
                    "Virtual": virtual
                };

                //set pool name, from msg.pool or uploader setting
                let poolName;
                if(msg.pool && msg.pool !== "") {
                    poolBody.Poolname = msg.pool;
                    poolName = msg.pool;
                } else {
                    poolBody.Poolname = pool_name;
                    poolName = pool_name;
                }

                //set stream name, from msg.stream or uploader setting
                let streamName;
                if(msg.topic && msg.topic !== "") {
                    streamName = msg.topic
                } else if(msg.stream && msg.stream !== "") {
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
                if(dataType === "Double") {
                    valueObj = {
                        "Ts": now.toISOString(),
                        "Val": msg.payload,
                        "ValStr": null,
                        "Calculated": false
                    };

                } else if(dataType === "String") {
                    valueObj = {
                        "Ts": now.toISOString(),
                        "Val": null,
                        "ValStr": msg.payload,
                        "Calculated": false
                    };

                }

                try {
                    //only build structure if valueObj has been assigned - String and Double types only
                    if(valueObj && poolName && streamName) buildStructure(poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType);
                } catch(e){

                }
            }
        });

        node.on('close', function() {
            nodeContext.set("uploader", this.uploader);

            //remove jobs on deploy to avoid memory leaks
            node.scheduler.removeById("checkState");
            node.scheduler.removeById("reInitialiseUploader");
        });

        function checkState() {

            node.mutex
            .acquire()
            .then(function(release) {
            
                let timeDiff = (Math.floor(Date.now() / 1000) - node.uploader.getUploadTs());
                
                let count = node.uploader.getLogCount();

                if(count >= uploadCount || timeDiff >= uploadInterval && node.uploading == false) {
                    //Wait for uploadCount setting to be met, OR, uploadInterval time to pass

                    node.uploading = true;

                    let uploadData = node.uploader.getBulkUploadData();

                    if(uploadData.length > 0) {
                        pushBulkUploadData(uploadData).then(function(uploadResult) {
                            if(uploadResult !== false) {
                                applyStatus({fill:"green",shape:"dot",text: new Date().toLocaleString()});
                                node.uploader.clearUploadedValues(count);                                
                            } else {
                                applyStatus({fill:"red",shape:"dot",text:"Unable to push to Bitpool "});
                                if(rebuildOnError) {
                                    reInitialiseUploader();
                                }
                            }
                            node.uploading = false;
                            release();
                        }).catch(function () {
                            applyStatus({fill:"red",shape:"dot",text:"Unable to push to Bitpool "});
                            if(rebuildOnError) {
                                reInitialiseUploader();
                            }
                            release();
                        });
                    } else {
                        node.uploading = false;
                        release();
                    }
                } else {
                    release();
                    //set pending status
                    applyStatus({fill:"blue",shape:"dot",text: count + " Logs Cached"});
                }
            });
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

        function buildStructure(poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType) {

            return new Promise(function(resolve, reject) {
                //check if log exists in cache
                let logExists = node.uploader.getLog(poolName, streamName) === undefined ? false : true;
                
                if(!logExists) {

                    // Log doesnt exist in cache, handle the creation of new log. 
                    // Check api for pool, create a new pool if not found
                    // Check api for stream, create a new station and stream within pool if not found

                    let poolExists = node.uploader.getPool(poolName) === undefined ? false : true;

                    let poolObj;
                    let poolKey;
                    let streamObj;

                    if(!poolExists) {

                        node.uploader.addPool({poolName: poolName, PoolKey: null});

                        setUpPool(poolBody).then(function(result) {

                            poolObj = result;

                            //set poolKey, based on 2 potential objects
                            poolKey = poolObj.Id || poolObj.PoolKey;

                            let poolTagsChanged = node.uploader.getPoolTagsChanged(poolKey, poolTags);

                            if(poolTagsChanged) {
                                addTagsToPool(poolKey, poolTags);
                                node.uploader.updatePoolTags(poolKey, poolTags);
                            }

                            // add pool to cache
                            node.uploader.updatePoolKey(poolName, poolKey);

                            setupStreams(poolObj, poolKey, streamName, dataType).then(function(streamObj) {

                                //set streamkey, based on 2 potential objects
                                let streamKey = streamObj.Id || streamObj.StreamKey;

                                let streamTagsChanged = node.uploader.getStreamTagsChanged(streamKey, streamTags);

                                if(streamTagsChanged) {
                                    addTagsToStream(streamKey, streamTags);
                                    node.uploader.updateStreamTags(streamKey, streamTags);
                                }
                                
                                // create new log
                                let log = new Log(poolName, streamName, poolTags, streamTags, poolKey, streamKey, valueObj);

                                // add to cache 
                                node.uploader.addToLogs(log);
                                resolve(log);
                            });
                        }).catch(function(error) {
                            reject(error);
                        });

                    } else {
                        
                        poolObj = node.uploader.getPool(poolName);
                        poolKey = poolObj.PoolKey;

                        if(poolKey !== null){

                            setupStreams(poolObj, poolKey, streamName, dataType).then(function(streamObj) {


                                //set streamkey, based on 2 potential objects
                                let streamKey = streamObj.Id || streamObj.StreamKey;

                                let streamTagsChanged = node.uploader.getStreamTagsChanged(streamKey, streamTags);

                                if(streamTagsChanged){
                                    addTagsToStream(streamKey, streamTags);
                                    node.uploader.updateStreamTags(streamKey, streamTags);
                                }

                                // create new log
                                let log = new Log(poolName, streamName, poolTags, streamTags, poolKey, streamKey, valueObj);

                                // add to cache 
                                node.uploader.addToLogs(log);

                                resolve(log);
                            }).catch(function(error) {
                                reject(error);
                            });
                        } else {

                            let metaDataObj = {
                                poolName: poolName, 
                                streamName: streamName, 
                                dataType: dataType,
                                poolTags: poolTags,
                                streamTags: streamTags,
                                valueObj: valueObj,
                                cb: streamCallback
                            };

                            node.uploader.addToStreamQueue(metaDataObj);
                        }
                    }

                } else {
                    // Log exists in cache, update with new value object
                
                    let foundLog = node.uploader.getLog(poolName, streamName);

                    node.uploader.updateLog(foundLog, valueObj);

                    let poolTagsChanged = node.uploader.getPoolTagsChanged(foundLog.poolkey, poolTags);

                    //update pool tags if changed
                    if(poolTagsChanged) {
                        addTagsToPool(foundLog.poolkey, poolTags);
                        node.uploader.updatePoolTags(foundLog.poolkey, poolTags);
                    }

                    let streamTagsChanged = node.uploader.getStreamTagsChanged(foundLog.streamKey, streamTags);

                    //update stream tags if changed
                    if(streamTagsChanged){
                        addTagsToStream(foundLog.streamKey, streamTags);
                        node.uploader.updateStreamTags(foundLog.streamKey, streamTags);
                    }

                    resolve(foundLog);
                }
            });
        };

        function streamCallback(poolObj, poolKey, meta) {

            let streamName = meta.streamName;
            let dataType = meta.dataType;

            let log = node.uploader.getLog(poolObj.poolName, streamName);

            let logExists = log === undefined ? false : true;

            if(logExists == false){
                setupStreams(poolObj, poolKey, streamName, dataType).then(function(streamObj) {

                    //set streamkey, based on 2 potential objects
                    let streamKey = streamObj.Id || streamObj.StreamKey;
    
                    let streamTagsChanged = node.uploader.getStreamTagsChanged(streamKey, meta.streamTags);
    
                    if(streamTagsChanged){
                        addTagsToStream(streamKey, meta.streamTags);
                        node.uploader.updateStreamTags(streamKey, meta.streamTags);
                    }
    
                    // create new log
                    let log = new Log(poolObj.poolName, streamName, meta.poolTags, meta.streamTags, poolKey, streamKey, meta.valueObj);
    
                    // add to cache 
                    node.uploader.addToLogs(log);
    
                }).catch(function(error) {
                });
            } else {
                //do nothing, stream already exists
                //node.uploader.updateLog(log, meta.valueObj);
            }
        }

        function setUpPool(poolBody) {
            return new Promise(function(resolve, reject) {
                //returns pool object if found in api
                getPoolIfExists(poolBody).then(function(poolObj) {
                    //create pool if doesnt exist
                    if(poolObj === false) {
                        createPool(poolBody).then(function(poolObj) {
                            resolve(poolObj);
                        });

                        // Unable to create pool, stop process. 
                        if(poolObj === false) {
                            applyStatus({fill:"red",shape:"dot",text:"Unable to create Pool. Check settings"});
                            return;
                        }
                        
                    } else {
                        node.uploader.addToPoolTags(poolBody, poolObj)
                        resolve(poolObj);
                    } 
                }).catch(function(error) {
                    reject(error);
                });
            });
        }

        function setupStreams(poolObj, poolKey, streamName, dataType) {
            return new Promise(function(resolve, reject) {
                if(typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null &&
                   typeof streamName !== 'undefined' && streamName !== "" && streamName !== null
                ) {
                    getStreamIfExists(poolKey, streamName).then(function(streamObj) {
                        if(streamObj === false) {
                            createStream(poolObj, streamName, dataType).then(function(streamObj) {
                                // Unable to create stream or station, stop process. 
                                if(streamObj === false) {
                                    applyStatus({fill:"red",shape:"dot",text:"Unable to create Stream. Check settings"});
                                    return;
                                } else {
                                    resolve(streamObj);
                                }
                            });
                        } else {
                            node.uploader.addToStreamTags(streamObj);
                            resolve(streamObj);
                        }
                    }).catch(function(error) {
                        reject(error);
                    });
                }
            });
        }

        function getPoolIfExists(body) {

            applyStatus({fill:"blue",shape:"dot",text:"Getting Pool"});

            return new Promise(function(resolve, reject) {
                if(body) {
                    let uri = `${node.rootUrlv1}pools/web-search?public=${body.Public}&virtual=${body.Virtual}&includeHidden=false&organisationOnly=true&search=${body.Poolname}&orderBy=Name&desc=false&take=5&skip=0`;
                    fetch(uri, {method: 'GET', headers: headers, agent: agent})
                    .then(function(res) {
                        if(res.status == 200){
                            res.json().then(function(payload) {    
                                if(payload.Pools.length > 0) {
                                    let foundPool = null;
                                    payload.Pools.forEach(function(poolObj){
                                        if(poolObj.Name == body.Poolname) {
                                            foundPool = poolObj;
                                        }
                                    });
                                    if(foundPool !== null) {
                                        applyStatus({fill:"blue",shape:"dot",text:"Found Pool"});
                                        resolve(foundPool);
                                    } else {
                                        applyStatus({fill:"blue",shape:"dot",text:"No Pool found"});
                                        resolve(false);
                                    }
                                } else {
                                    applyStatus({fill:"blue",shape:"dot",text:"No Pool found"});
                                    resolve(false);
                                }
                            });
                        } else {
                            logOut("Unable to get pool, response: ", res);
                            applyStatus({fill:"red",shape:"dot",text:"Error getting Pool. Code: " + res.status});
                            resolve(false);
                        }
                    }).catch(function(error) {
                        logOut("Unable to get pool: ", error);
                        applyStatus({fill:"red",shape:"dot",text:"Error getting Pool"});
                        reject(error);
                    });
                }
            });
        };

        function getStreamIfExists(poolKey, streamName) {

            applyStatus({fill:"blue",shape:"dot",text:"Getting Stream"});

            return new Promise(function(resolve, reject) {
                if (typeof streamName !== 'undefined' && streamName !== "" && streamName !== null) {
                    let uri = `${node.rootUrlv1}pool/${poolKey}/streams/web-search?&search=${streamName}&orderBy=Name&desc=false&take=5&skip=0`;
                    fetch(uri, {method: 'GET', headers: headers, agent: agent})
                    .then(function(res) {
                        if(res.status == 200) {
                            res.json().then(function(payload) {
                                let foundStream = null;
                                if(payload.Streams.length > 0) {
                                    payload.Streams.forEach(function(streamObj) {
                                        if(streamObj.Name == streamName) {
                                            foundStream = streamObj;
                                        }
                                    });
                                }
                                if(foundStream !== null) {
                                    applyStatus({fill:"blue",shape:"dot",text:"Found Stream"});
                                    resolve(foundStream);
                                } else {
                                    applyStatus({fill:"blue",shape:"dot",text:"No Stream found"});
                                    resolve(false);
                                }
                            });
                        } else {
                            logOut("Unable to get stream, response: ", res.status);
                            resolve(false);
                            applyStatus({fill:"red",shape:"dot",text:"Error getting Stream. Code: " + res.status});
                        }
                    }).catch(function(error) {
                        logOut("Unable to get stream: ", error);
                        applyStatus({fill:"red",shape:"dot",text:"Error getting Stream"});
                        reject(error);
                    });
                }
            });
        };

        //creates a new pool
        function createPool(body) {

            applyStatus({fill:"blue",shape:"dot",text:"Creating new Pool"});

            return new Promise(function(resolve, reject) {
                fetch(node.rootUrlv2 + "pools", {method: 'POST', headers: headers, agent: agent, body: JSON.stringify(body)})
                .then(function(res) {
                    if(res.status == 200) {
                        res.json().then(function(payload){
                            resolve(payload);
                        });
                    } else {
                        logOut("Unable to create pool, response: ", res);
                        resolve(false);
                    }
                }).catch(function(error) {
                    logOut("Unable to create pool: ", error);
                    applyStatus({fill:"red",shape:"dot",text:"Error creating pool"});
                    reject(error);
                });
            });
        }

        //creates a new station in provided pool
        function createStation(poolKey, pool) {
            applyStatus({fill:"blue",shape:"dot",text:"Creating new station"});

            let stationId = pool.Name || pool.poolName || "1";

            let stationExists = node.uploader.getStation(poolKey);

            return new Promise(function(resolve, reject) {

                if(!stationExists) {

                    node.uploader.addStation({poolKey: poolKey});
            
                    fetch(node.rootUrlv2 + `pools/${poolKey}/stations`, {method: 'POST', headers: headers, agent: agent, body: JSON.stringify(stationId)})
                    .then(function(res) {
                        if(res.status == 200){
                            res.json().then(function(payload) {
                                node.uploader.updateStationId(poolKey, payload.StationID)
                                resolve(payload);
                            });
                        } else {
                            logOut("Unable to create station, response: ");
                            logOut(res);
                            applyStatus({fill:"blue",shape:"dot",text:"Error creating station. Error: " + res.status});
                            reject(res);
                        }
                    }).catch(function(error) {
                        logOut("Unable to create station: ", error);
                        applyStatus({fill:"blue",shape:"dot",text:"Error creating station "});
                        reject(error);
                    });
                } else {
                    resolve(stationExists);
                }
            });
        }

        //get stations for pool
        function getStationIfExists(poolKey) {
            applyStatus({fill:"blue",shape:"dot",text:"Getting Station for stream"});
            return new Promise(function(resolve, reject) {
                fetch(node.rootUrlv2 + `pools/${poolKey}/stations`, {method: 'GET', headers: headers, agent: agent})
                .then(function(res){
                    if(res.status == 200){
                        res.json().then(function(payload) {
                            let foundStation = null;
                            if(payload.length > 0) {
                                foundStation = payload[0];
                            }
                            if(foundStation !== null) {
                                applyStatus({fill:"blue",shape:"dot",text:"Found Station"});
                                resolve(foundStation);
                            } else {
                                resolve(false);
                            }
                        });
                    } else {
                        resolve(false);
                        logOut("Unable to get station, response: ", res.status);
                        applyStatus({fill:"red",shape:"dot",text:"Error getting Station in pool. Error: " + res.status});
                    }
                }).catch(function(error) {
                    reject(error);
                });
            });
        }

        //checks/creates station in pool, then creates stream for 1ST station. 
        function createStream(pool, streamName, dataType) {
            let poolKey = pool.Id || pool.PoolKey;

            applyStatus({fill:"blue",shape:"dot",text:"Creating new Stream"});

            return new Promise(function(resolve, reject) {
                if (typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null) getStationIfExists(poolKey).then(async function(station) {
                    if(station === false) {
                        applyStatus({fill:"blue",shape:"dot",text:"No station found"});
                        station = await createStation(poolKey, pool);
                    }

                    if(station !== false) {
                        let streamBody = {
                            "LocalIndex": streamName,
                            "StreamName": streamName,
                            "Description": streamName,
                            "Public": public,
                            "DataType": dataType
                        };

                        function create() {
                            if(typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null &&
                               typeof station.StationID !== 'undefined' && station.StationID !== "" && station.StationID !== null
                            ) {
                                fetch(node.rootUrlv2 + `pools/${poolKey}/stations/${station.StationID}/streams`, {method: 'POST', headers: headers, agent: agent, body: JSON.stringify(streamBody)})
                                .then(function(res) {
                                    if(res.status == 200) {
                                        res.json().then(function(payload){
                                            resolve(payload);
                                        });
                                    } else {
                                        logOut("Unable to create stream, response: ", res);
                                        logOut(res);
                                        applyStatus({fill:"red",shape:"dot",text:"Error creating Stream. Error: " + res.status});
                                        resolve(false);
                                    }
                                }).catch(function(error) {
                                    logOut(error);
                                    logOut("Error creating Stream. Error: ", error);
                                    applyStatus({fill:"red",shape:"dot",text:"Error creating Stream. Error: " + error});
                                    resolve(false);
                                });
                            }
                        }

                        if(station.StationID) {
                            create();
                        } else {
                            node.uploader.addToStationQueue(poolKey, station, streamBody, create);
                        }
                    } else {
                        applyStatus({fill:"red",shape:"dot",text:"Error getting Station "});
                        resolve(false);
                    }

                }).catch(function(error) {
                    logOut(error);
                    applyStatus({fill:"red",shape:"dot",text:"Error getting Station in pool"});
                });
            });
        }

        //uploads bulk data to cloud
        function pushBulkUploadData(uploadData) {
            applyStatus({fill:"blue",shape:"dot",text:"Pushing to Bitpool"});
            let body = JSON.stringify(uploadData);
            return new Promise(function(resolve, reject) {
                fetch(node.rootUrlv2 + "streams/logs", {method: 'POST', headers: headers, agent: agent, body: body})
                .then(function(res) {
                    if(res.status == 200) {
                        resolve(true);
                    } else {
                        logOut("Unable to upload to bitpool, response: ", res);
                        logOut(res);
                        resolve(false);
                    }
                }).catch(function(error) {
                    reject(error);
                    logOut("Unable to upload to bitpool, response: ", error);
                });
            });
        }

        function addTagsToStream(streamKey, tags) {
            //push tags to stream
            if(tags && tags !== "" && tags.length > 0 && streamKey){
                let newTagResult = pushNewTagsToStream(streamKey, tags);
            }
        }

        function addTagsToPool(poolKey, tags) {
            //push tags to pool
            if(tags && tags !== "" && tags.length > 0 && poolKey) {
                let newTagResult = pushNewTagsToPool(poolKey, tags);
            }
        }

        //Inserts specified tags to current stream
        function pushNewTagsToStream(streamKey, tags) {
            return new Promise(function(resolve, reject) {
                applyStatus({fill:"blue",shape:"dot",text:"Pushing tags to stream"});
                if (typeof streamKey !== 'undefined' && streamKey !== "" && streamKey !== null && tags) {
                    fetch(node.rootUrlv3 + `stream/${streamKey}/tags`, {method: 'POST', headers: headers, agent: agent, body: JSON.stringify(tags)})
                    .then(function(res) {
                        //returns true if sucessfully added tags
                        if(res.status == 204 || res.status == 200) {
                            //applyStatus({fill:"green",shape:"dot",text:"Uploaded Tags "+ new Date().toLocaleString()});
                            resolve(true);
                        } else {
                            applyStatus({fill:"red",shape:"dot",text:"Error pushing tags to stream. Error: " + res.status});
                            resolve(false);
                        }
                    }).catch(function(error) {
                        reject(error);
                    });
                }
            });
        }

        //Inserts specified tags to current pool
        function pushNewTagsToPool(poolKey, tags) {
            return new Promise(function(resolve, reject) {
                applyStatus({fill:"blue",shape:"dot",text:"Pushing tags to pool"});
                if (typeof poolKey !== 'undefined' && poolKey !== "" && poolKey !== null && tags) {
                    fetch(node.rootUrlv3 + `pool/${poolKey}/tags`, {method: 'POST', headers: headers, agent: agent, body: JSON.stringify(tags)})
                    .then(function(res) {
                        //returns true if sucessfully added tags
                        if(res.status == 204 || res.status == 200) {
                            //applyStatus({fill:"green",shape:"dot",text:"Uploaded Tags"+ new Date().toLocaleString()});
                            resolve(true);
                        } else {
                            applyStatus({fill:"red",shape:"dot",text:"Error pushing tags to pool. Error: " + res.status});
                            resolve(false);
                        }
                    }).catch(function(error) {
                        reject(error);
                    });
                }
            });
        }

        //Returns msg.payload data type - either Double or String as per bitpool api - 
        function getDataType(value) {
            let toType = function(obj) {
                return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
            };
            let type = toType(value);
            if(value.constructor === ({}).constructor) {
                return "JSONObject"
            } else if(isJsonString(value) == true){
                return "JSONObject"
            } else if(value == "") {
                return "Empty"
            } else if(value == null || value == undefined || value == 'undefined') {
                return "Null"
            } else {
                switch(type) {
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

        function isJsonString(strData) {
            try {
                let obj = JSON.parse(strData);
                let keys = Object.keys(obj);
                if(keys.length > 0){
                    return true;
                } else {
                    return false;
                }
            } catch (e) {
                return false;
            }
        }

        function applyStatus(jsonProps) {
            if(bpChkShowDateOnLabel) {
                node.status(jsonProps)
            }
        }

        function logOut(param1, param2) {
            if(bpChkShowDebugWarnings) {
                if(param1) node.warn(param1);
                if(param2) node.warn(JSON.stringify(param2));
            }
        }
    };
    RED.nodes.registerType('uploader',BITPOOL);
}
