/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/


const _ = require("underscore");

class Uploader {
    constructor() {
        this.logs = [];

        this.pools = [];

        this.stations = [];

        this.poolTags = [];

        this.streamTags = [];

        this.streamDataCount = 0;

        this.uploadTs = Math.floor(+ new Date() / 1000);

        // poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType
        this.queue = [];

        this.addToQueue = function (poolBody, poolName, streamName, poolTags, streamTags, valueObj, dataType) {
            this.queue.push({ poolBody: poolBody, poolName: poolName, streamName: streamName, poolTags: poolTags, streamTags: streamTags, valueObj: valueObj, dataType: dataType });
        }

        this.getQueueAndClean = function () {
            const result = this.queue;
            this.queue = [];
            return result;
        }

        this.getPoolTagsChanged = function (poolKey, tags) {

            if (poolKey && tags && poolKey !== null && tags !== null) {
                let poolTags = this.poolTags.find(ele => ele.poolKey === poolKey);

                if (!poolTags) return true;

                if (tags.length > poolTags.tags.length) return true;

                let difference = _.difference(tags, poolTags.tags);

                if (difference.length > 0) {
                    return true;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }

        this.getStreamTagsChanged = function (streamKey, tags) {

            if (streamKey && tags && streamKey !== null && tags !== null) {
                let streamTags = this.streamTags.find(ele => ele.streamKey === streamKey);

                if (!streamTags) return true;

                if (tags.length > streamTags.tags.length) return true;

                let difference = _.difference(tags, streamTags.tags);

                if (difference.length > 0) {
                    return true;
                } else {
                    return false;
                }

            } else {
                return false;
            }
        }

        this.updateStreamTags = function (key, tags) {
            let that = this;
            let streamExists = that.streamTags.findIndex(ele => ele.streamKey === key);

            if (streamExists !== -1) {
                let difference = _.difference(tags, that.streamTags[streamExists].tags);
                if (difference.length > 0) {
                    that.streamTags[streamExists].tags = that.streamTags[streamExists].tags.concat(difference);
                }
            } else {
                that.streamTags.push({ streamKey: key, tags: tags })
            }
        }

        this.addToStreamTags = function (res) {
            let that = this;

            if (res.Tags.length > 0) {
                let streamExists = that.streamTags.findIndex(ele => ele.streamKey === res.Id);
                if (streamExists !== -1) {
                    that.streamTags[streamExists].tags = res.Tags;
                } else if (streamExists === -1) {
                    that.streamTags.push({ streamKey: res.Id, tags: res.Tags })
                }
            }
        }

        this.updatePoolTags = function (key, tags) {
            let that = this;
            let poolExists = that.poolTags.findIndex(ele => ele.poolKey === key);

            if (poolExists !== -1) {
                let difference = _.difference(tags, that.poolTags[poolExists].tags);
                if (difference.length > 0) {
                    that.poolTags[poolExists].tags = that.poolTags[poolExists].tags.concat(difference);
                }
            } else {
                that.poolTags.push({ poolKey: key, tags: tags })
            }
        }

        this.addToPoolTags = function (poolObj, res) {
            let that = this;

            if (res.Tags.length > 0) {
                let poolExists = that.poolTags.findIndex(ele => ele.poolKey === res.Id);
                if (poolExists !== -1) {
                    that.poolTags[poolExists].tags = res.Tags;
                } else if (poolExists === -1) {
                    that.poolTags.push({ poolKey: res.Id, tags: res.Tags })
                }
            }
        }

        this.addStation = function (station) {
            this.stations.push(station);
        }

        this.getStation = function (poolKey) {
            return this.stations.find(station => station.poolKey === poolKey);
        }

        this.getLogs = function () {
            return this.logs;
        }

        this.getLog = function (poolName, streamName) {
            return this.logs.find(log => log.poolName === poolName && log.streamName === streamName);
        }

        this.getPool = function (poolName) {
            //return this.pools.find(pool => pool.poolName === poolName && pool.PoolKey !== null);
            return this.pools.find(pool => pool.poolName === poolName);
        }

        this.addPool = function (poolObject) {
            this.pools.push(poolObject);
        }

        this.addToLogs = function (log) {
            this.logs.push(log);
            this.streamDataCount++;
        }

        this.updateLog = function (log, valueObj) {
            let logIndex = this.logs.findIndex(ele => ele.poolName === log.poolName && ele.streamName === log.streamName);
            this.logs[logIndex].values.push(valueObj);
            this.logs[logIndex].valueCount++;
            this.streamDataCount++;
        };

        this.getUploadTs = function () {
            return this.uploadTs;
        };

        this.getLogCount = function () {
            return this.streamDataCount;
        };

        this.getBulkUploadData = function () {
            let uploadData = [];
            for (let i = 0; i < this.logs.length; i++) {
                let log = this.logs[i];
                //check for duplicate stream keys
                let foundIndex = uploadData.findIndex(data => data.StreamKey == log.streamKey);
                if (foundIndex === -1) {
                    //not found, push to array
                    uploadData.push({
                        "StreamKey": log.streamKey,
                        "Values": log.values
                    });
                } else {
                    //found duplicate, add to values
                    log.values.forEach(function (value) {
                        uploadData[foundIndex].Values.push(value);
                    });
                }
            }

            return uploadData;
        }

        this.clearUploadedValues = function (count) {
            for (let i = 0; i < this.logs.length; i++) {
                this.logs[i].values = [];
                this.logs[i].valueCount = 0;
            }
            this.streamDataCount = 0;
            this.uploadTs = Math.floor(+ new Date() / 1000);
        }
    }
}

module.exports = { Uploader };