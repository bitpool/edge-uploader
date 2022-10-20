/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/


const os = require("os");

module.exports = function(RED) {
    function apptag(config) {        
        RED.nodes.createNode(this,config);
        var node = this;

        this.StreamTags = config.StreamTags;
        this.PoolTags = config.PoolTags;
    
        node.on('input', function(msg) {

            if(node.StreamTags) msg.StreamTags = node.StreamTags;
            if(node.PoolTags) msg.PoolTags = node.PoolTags;
            
            node.send(msg);

            node.status({fill:"green",shape:"dot",text:"Tags added to payload"});
        });
    }
    
    RED.nodes.registerType("metatag",apptag);
}