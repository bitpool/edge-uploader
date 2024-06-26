/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

module.exports = function(RED) {
    function BitpoolApiKey(config) {

        this.name = config.name;
        this.api_key = config.api_key;
        
        RED.nodes.createNode(this,config);
    }
    RED.nodes.registerType("Bitpool-Api-Key", BitpoolApiKey);
}