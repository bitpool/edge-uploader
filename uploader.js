/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/


const _ = require("underscore");

class Uploader {
    constructor() {
        this.logs = [];

        this.pools = [];

        this.streamQ = [];

        this.stations = [];

        this.stationQ = [];

        this.poolTags = [];

        this.streamTags = [];

        this.streamDataCount = 0;

        this.uploadTs = Math.floor(+ new Date() / 1000);

        this.getPoolTagsChanged = function(poolKey, tags) {

            if(poolKey && tags && poolKey !== null && tags !== null ) {
                let poolTags = this.poolTags.find(ele => ele.poolKey === poolKey);

                if(!poolTags) return true;

                if(tags.length > poolTags.tags.length) return true;

                let difference = _.difference(tags, poolTags.tags);

                if(difference.length > 0) {
                    return true;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }

        this.getStreamTagsChanged = function(streamKey, tags) {

            if(streamKey && tags && streamKey !== null && tags !== null ) {
                let streamTags = this.streamTags.find(ele => ele.streamKey === streamKey);

                if(!streamTags) return true;
    
                if(tags.length > streamTags.tags.length) return true;

                let difference = _.difference(tags, streamTags.tags);

                if(difference.length > 0) {
                    return true;
                } else {
                    return false;
                }
    
            } else {
                return false;
            }
        }

        this.updateStreamTags = function(key, tags) {
            let that = this;
            let streamExists = that.streamTags.findIndex(ele => ele.streamKey === key);

            if(streamExists !== -1) {
                let difference = _.difference(tags, that.streamTags[streamExists].tags);
                if(difference.length > 0) {
                    that.streamTags[streamExists].tags = that.streamTags[streamExists].tags.concat(difference);
                }
            } else {
                that.streamTags.push({streamKey: key, tags: tags})
            }
        }

        this.addToStreamTags = function(res) {
            let that = this;

            if(res.Tags.length > 0) {
                let streamExists = that.streamTags.findIndex(ele => ele.streamKey === res.Id);
                if(streamExists !== -1) {
                    that.streamTags[streamExists].tags = res.Tags;
                } else if(streamExists === -1) {
                    that.streamTags.push({streamKey: res.Id, tags: res.Tags})
                }
            }
        }

        this.updatePoolTags = function(key, tags) {
            let that = this;
            let poolExists = that.poolTags.findIndex(ele => ele.poolKey === key);

            if(poolExists !== -1) {
                let difference = _.difference(tags, that.poolTags[poolExists].tags);
                if(difference.length > 0) {
                    that.poolTags[poolExists].tags = that.poolTags[poolExists].tags.concat(difference);
                }
            } else {
                that.poolTags.push({poolKey: key, tags: tags})
            }
        }

        this.addToPoolTags = function(poolObj, res) {
            let that = this;

            if(res.Tags.length > 0) {
                let poolExists = that.poolTags.findIndex(ele => ele.poolKey === res.Id);
                if(poolExists !== -1){
                    that.poolTags[poolExists].tags = res.Tags;
                } else if(poolExists === -1) {
                    that.poolTags.push({poolKey: res.Id, tags: res.Tags})
                }
            }
        }

        this.clearStationQueue = function(poolKey){
            let that = this;
            that.stationQ.forEach(function(item, index){
                if(item.poolKey === poolKey) {
                    item.cb()
                }
            });
        }

        this.addToStationQueue = function(poolKey, station, streamBody, cb) {
            this.stationQ.push({poolKey: poolKey, station: station, streamBody: streamBody, cb: cb})
        }

        this.updateStationId = function(poolKey, stationId) {
            let stationIndex = this.stations.findIndex(ele => ele.poolKey === poolKey);
            if(stationIndex !== -1){
                this.stations[stationIndex].StationID = stationId;
                this.clearStationQueue(poolKey);
            } 
        }

        this.addStation = function(station) {
            this.stations.push(station);
        }

        this.getStation = function(poolKey) {
            return this.stations.find(station => station.poolKey === poolKey);
        }

        this.addToStreamQueue = function(item) {
            let streamExists = this.streamQ.findIndex(ele => ele.poolName === item.poolName && ele.streamName === item.streamName);
            if(streamExists === -1){
                //add to queue if its not already present in queue
                this.streamQ.push(item);
            }
        }

        this.clearStreamQueue = function(poolName, poolKey) {
            let that = this;
            this.streamQ.forEach(function(item, index) {
                if(item.poolName == poolName){
                    let pool = that.getPool(poolName);
                    item.cb(pool, poolKey, item);
                }
            });
        }

        this.getLogs = function() {
            return this.logs;
        }

        this.getLog = function(poolName, streamName) {
            return this.logs.find(log => log.poolName === poolName && log.streamName === streamName);
        }

        this.getPool = function(poolName){
            //return this.pools.find(pool => pool.poolName === poolName && pool.PoolKey !== null);
            return this.pools.find(pool => pool.poolName === poolName);
        }

        this.addPool = function(poolObject) {
            this.pools.push(poolObject);
        }

        this.updatePoolKey = function(poolName, poolKey) {
            let poolIndex = this.pools.findIndex(ele => ele.poolName === poolName);
            this.pools[poolIndex].PoolKey = poolKey;

            this.clearStreamQueue(poolName, poolKey);
        }

        this.updatePool = function(pool) {
            let poolIndex = this.pools.findIndex(ele => ele.poolName === pool.poolName);
            this.pools[poolIndex] = pool;
        }

        this.addToLogs = function(log) {
            this.logs.push(log);
            this.streamDataCount++;
        }

        this.updateLog = function(log, valueObj) {
            let logIndex = this.logs.findIndex(ele => ele.poolName === log.poolName && ele.streamName === log.streamName);
            this.logs[logIndex].values.push(valueObj);
            this.logs[logIndex].valueCount++;
            this.streamDataCount++;
        };

        this.getUploadTs = function() {
            return this.uploadTs;
        };

        this.getLogCount = function() {
            return this.streamDataCount;
        };

        this.getBulkUploadData = function() {
            let uploadData = [];
            for(let i = 0; i < this.logs.length; i++){
                let log = this.logs[i];
                //check for duplicate stream keys
                let foundIndex = uploadData.findIndex(data => data.StreamKey == log.streamKey);
                if(foundIndex === -1){
                    //not found, push to array
                    uploadData.push({
                        "StreamKey": log.streamKey,
                        "Values": log.values
                    });
                } else {
                    //found duplicate, add to values
                    log.values.forEach(function(value){
                        uploadData[foundIndex].Values.push(value);
                    });
                }
            }

            return uploadData;
        }

        this.clearUploadedValues = function(count) {
            for(let i = 0; i < this.logs.length; i++) {
                this.logs[i].values = [];
                this.logs[i].valueCount = 0;
            }
            this.streamDataCount = 0;
            this.uploadTs = Math.floor(+ new Date() / 1000);
        }
    }
}

module.exports = { Uploader };