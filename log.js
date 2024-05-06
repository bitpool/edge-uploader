/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

class Log {
    constructor(poolName, streamName, poolTags, streamTags, poolkey, streamKey, valueObj){
        this.poolName = poolName;
        this.streamName = streamName;
        this.poolkey = poolkey;
        this.streamKey = streamKey;
        this.poolTags = poolTags;
        this.streamTags = streamTags;
        this.stationId = null;
        this.lastUploadTs = null;
        this.values = [valueObj];
        this.valueCount = 1;
    }
}
module.exports = {Log};