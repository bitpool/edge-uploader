/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/

module.exports = function (RED) {
  function BitpoolApiKey(config) {

    this.name = config.name;
    this.api_key = cleanUserInput(config.api_key);
    this.api_endpoint = cleanUserInput(config.api_endpoint);

    RED.nodes.createNode(this, config);
  }
  function cleanUserInput(input) {
    if (typeof input !== 'string') {
      return '';
    }
    // Remove non-printable characters, including control characters
    return input.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  }
  RED.nodes.registerType("Bitpool-Api-Key", BitpoolApiKey);
}