/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/

module.exports = function(RED) {
    function BitpoolTagLibrary(config) {

        this.name = config.name;
        this.file = config.file;
        this.fileName = config.fileName;
        this.libJson = config.libJson;
        this.enabled = config.enabled;
        
        RED.nodes.createNode(this,config);
    }
    RED.nodes.registerType("Bitpool-Tag-Library", BitpoolTagLibrary);
}