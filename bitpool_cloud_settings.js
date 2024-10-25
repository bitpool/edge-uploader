/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/


module.exports = function (RED) {
  function BitpoolCloudSettings(config) {

    let name = config.name;
    let apiKey = config.api_key;

    RED.nodes.createNode(this, config);
  }
  RED.nodes.registerType("Bitpool-Cloud-Settings", BitpoolCloudSettings);
}