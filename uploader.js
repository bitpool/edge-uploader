/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/


const _ = require("underscore");
const camelCase = require('camelcase');

// If we have not worked out the data type, assume it is a double
const DataType = Object.freeze({
    DOUBLE: "Double",
    STRING: "String",
    UNKNOWN: "Double"
});

// Assume a stream reads every 5 mins
// (60/5)x24 = 288 readings per day
// 2000/288 = ~7days
const MAX_RECORDS_PER_STREAM = 2000;

class Data {
    constructor() {
        this.dataType = DataType.UNKNOWN;
        this.timestampOfFirstRecord = new Date();
        this.values = [];
    }

    addValue(value) {

        const timestamp = new Date().toISOString();
        if (typeof value === "boolean") {
            value = value.toString();
        }
        this.values.push({ timestamp, value });

        // Ensure array does not exceed MAX_RECORDS_PER_STREAM
        if (this.values.length > MAX_RECORDS_PER_STREAM) {
            this.values.shift(); // Remove the oldest value
        }

        // Set dataType based on the first entry
        if (this.values.length === 1) {
            this.timestampOfFirstRecord = new Date();
            this.dataType = Data.checkDataType(value);
        }
    }

    getFirstRecordTimestamp() {
        return this.timestampOfFirstRecord;
    }

    static checkDataType(value) {
        if (typeof value === "number") {
            return DataType.DOUBLE;
        } else if (typeof value === "string") {
            return DataType.STRING;
        } else if (typeof value === "boolean") {
            return DataType.STRING;
        } else {
            return DataType.UNKNOWN;
        }
    }

    getDataType() {
        return this.dataType;
    }

    getAllValues() {
        const allValues = this.values.map(val => ({
            Ts: val.timestamp,
            Val: this.dataType === DataType.DOUBLE ? val.value : null,
            ValStr: this.dataType === DataType.STRING ? val.value : null,
            Calculated: false
        }));
        this.values = [];
        return allValues;
    }

    getSomeValues(count) {
        const someValues = this.values.slice(0, count).map(val => ({
            Ts: val.timestamp,
            Val: this.dataType === DataType.DOUBLE ? val.value : null,
            ValStr: this.dataType === DataType.STRING ? val.value : null,
            Calculated: false
        }));
        this.values = this.values.slice(count);
        return someValues;
    }

    delete() {
        this.values = [];
    }
    static fromJSON(json) {
        const data = new Data();
        data.dataType = json.dataType;
        data.values = json.values;
        return data;
    }
    toJSON() {
        return {
            dataType: this.dataType,
            values: this.values
        };
    }
}

class Stream {
    constructor(streamName = "", streamKey = "", streamTags = []) {
        this.streamName = streamName;
        this.streamKey = streamKey;
        this.streamTags = streamTags;
        this.data = new Data();
    }
    addData(value) {
        this.data.addValue(value);
        return {
            count: this.data.values.length,
            firstTs: this.data.getFirstRecordTimestamp()
        }
    }

    getQueueDetails() {
        return {
            count: this.data.values.length,
            firstTs: this.data.getFirstRecordTimestamp()
        }
    }
    getData() {
        return this.data;
    }
    getStreamKey() {
        return this.streamKey || null;
    }
    getStreamName() {
        return this.streamName || null;
    }

    updateTags(tags) {
        this.streamTags = tags;
    }
    getStreamTags() {
        return this.streamTags;
    }
    getDataType() {
        return this.data.getDataType();
    }
    getAllValues() {
        return this.data.getAllValues();
    }
    getSomeValues(count) {
        return this.data.getSomeValues(count);
    }
    getRecordCount() {
        return this.data.values.length || 0;
    }
    getFirstRecordTimestamp() {
        return this.data.getFirstRecordTimestamp();
    }

    static fromJSON(json) {
        const stream = new Stream();
        stream.streamName = json.streamName;
        stream.streamKey = json.streamKey;
        stream.streamTags = json.streamTags;
        stream.data = Data.fromJSON(json.data);
        return stream;
    }
    toJSON() {
        return {
            streamName: this.streamName,
            streamKey: this.streamKey,
            streamTags: this.streamTags,
            data: this.data.toJSON()
        };
    }
}

class Streams {
    constructor() {
        this.streams = new Map();
        this.nameToKey = new Map();
        this.keyToName = new Map();
        this.countOfAllRecs = 0;
    }

    addStreamName(streamName) {
        if (!streamName) {
            throw new Error("Stream name cannot be empty");
        }
        if (this.streams.has(streamName) == false) {
            this.streams.set(streamName, new Stream(streamName));
        }
    }
    updateStreamKey(streamName, streamKey = null) {
        if (!streamName) {
            throw new Error("Stream name cannot be empty");
        }
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.streamKey = streamKey;
            this.nameToKey.set(streamName, streamKey);
            if (streamKey) {
                this.keyToName.set(streamKey, streamName);
            }
        }
    }

    getCountOfAllRecords() {
        let totalRecords = 0;
        this.streams.forEach(stream => {
            totalRecords += stream.getRecordCount();
        });
        this.countOfAllRecs = totalRecords;
        return totalRecords;
    }
    getStreamByNameOrKey(identifier) {
        if (!identifier) {
            throw new Error("Identifier cannot be empty");
        }
        const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(identifier);

        if (isGuid) {
            const streamName = this.keyToName.get(identifier);
            return streamName ? this.streams.get(streamName) : null;
        } else {
            return this.streams.get(identifier) || null;
        }
    }
    getStreamKeyList() {
        return Array.from(this.nameToKey.values());
    }
    getStreamCount() {
        return this.streams.size;
    }
    getStreamNameByKey(streamGuid) {
        return this.keyToName.get(streamGuid) || null;
    }
    purgeRecordsOnly() {
        this.streams.forEach(stream => {
            stream.data.values = [];
        });
        this.countOfAllRecs = 0
    }
    updateStreamTags(streamName, tags) {
        if (!streamName || !tags) {
            throw new Error("Stream name and tags cannot be empty");
        }
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.streamTags = tags;
        } else {
            throw new Error("Stream not found");
        }
    }

    getEarliestTimestamp() {
        let earliestTimestamp = null;
        this.streams.forEach(stream => {
            const streamTimestamp = stream.getFirstRecordTimestamp();
            if (earliestTimestamp === null || streamTimestamp < earliestTimestamp) {
                earliestTimestamp = streamTimestamp;
            }
        });
        return earliestTimestamp;
    }
    delete(streamName) {
        this.streams.delete(streamName);
    }

    deleteValues(streamName) {
        if (this.streams.has(streamName)) {
            const existingStream = this.streams.get(streamName);
            existingStream.data.values = []
        }
    }

    static fromJSON(json) {
        const streams = new Streams();
        streams.countOfAllRecs = json.countOfAllRecs || 0;
        streams.nameToKey = new Map(json.nameToKey);
        streams.keyToName = new Map(json.keyToName);
        streams.streams = new Map(Object.entries(json.streams).map(([key, value]) => [key, Stream.fromJSON(value)]));
        return streams;
    }

    toJSON() {
        const streamsObj = {};
        this.streams.forEach((value, key) => {
            streamsObj[key] = value.toJSON();
        });
        return {
            countOfAllRecs: this.countOfAllRecs,
            nameToKey: Array.from(this.nameToKey.entries()),
            keyToName: Array.from(this.keyToName.entries()),
            streams: streamsObj,
        };
    }
}

class Pool {
    constructor() {
        this.poolName = "";
        this.poolKey = "";
        this.stationId = "";
        this.poolTags = [];
        this.streams = new Streams();
    }

    setPoolName(poolName) {
        this.poolName = poolName;
    }
    getPoolName() {
        return this.poolName || null;
    }

    setPoolKey(poolKey) {
        this.poolKey = poolKey;
    }
    getPoolKey() {
        return this.poolKey || null;
    }

    setStationId(stationId) {
        this.stationId = stationId;
    }
    getStationId() {
        return this.stationId || null;
    }

    setPoolTags(poolTags) {
        if (Array.isArray(poolTags)) {
            this.poolTags = poolTags.map(tag => tag.trim());
        } else {
            throw new Error("Invalid input: poolTags must be a string or an array");
        }
    }
    getStreamCount() {
        return this.streams.getStreamCount();
    }
    getEarliestTimestamp() {
        return this.streams.getEarliestTimestamp();
    }
    getCountOfAllRecords() {
        return this.streams.getCountOfAllRecords();

    }
    getStreamNameByKey(streamGuid) {
        return this.streams.getStreamNameByKey(streamGuid);
    }
    createTagListFromString(tags) {
        return tags ? tags.split(/\s*,\s*/) : [];
    }
    purgeRecordsOnly() {
        this.streams.purgeRecordsOnly();
    }
    cleanTags(tagStr) {
        const cleanedTagList = tagStr.split(',');
        return cleanedTagList.map(item => {
            const equalIndex = item.indexOf('=');
            if (equalIndex !== -1) {
                const keyValue = item.substring(0, equalIndex).split(':').pop();
                const value = item.substring(equalIndex + 1).trim();
                return `${camelCase(keyValue.trim())}=${value}`;
            }
            return item;
        });
    }

    findMissingTags(nodePoolTags, serverPoolTags) {
        const missingTags = nodePoolTags.filter(tag => !serverPoolTags.includes(tag));
        return missingTags.length > 0 ? missingTags : [];
    }


    addStreamName(streamName) {
        this.streams.addStreamName(streamName);
    }
    updateStreamKey(streamName, streamKey = null) {
        this.streams.updateStreamKey(streamName, streamKey);
    }

    getStreamByNameOrKey(identifier) {
        return this.streams.getStreamByNameOrKey(identifier);
    }

    getStreamKeyList() {
        return this.streams.getStreamKeyList();
    }

    updateStreamTags(streamName, tags) {
        this.streams.updateStreamTags(streamName, tags);
    }

    deleteStream(streamName) {
        this.streams.delete(streamName);
    }

    deleteStreamValues(streamName) {
        this.streams.deleteValues(streamName);
    }

    stream(streamName) {
        const stream = this.streams.getStreamByNameOrKey(streamName);
        if (!stream) {
            throw new Error("Stream not found");
        }
        return stream;
    }

    static fromJSON(json) {
        const pool = new Pool();
        pool.poolName = json.poolName;
        pool.poolKey = json.poolKey;
        pool.stationId = json.stationId;
        pool.poolTags = json.poolTags;
        pool.streams = Streams.fromJSON(json.streams);
        return pool;
    }

    toJSON() {
        return {
            poolName: this.poolName,
            poolKey: this.poolKey,
            stationId: this.stationId,
            poolTags: this.poolTags,
            streams: this.streams.toJSON()
        };
    }
}

module.exports = { Pool };