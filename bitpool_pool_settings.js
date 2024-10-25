/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/


'use strict'

module.exports = function (RED) {
  function BitpoolPoolSettings(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.pool_name = cleanUserInput(config.pool_name);
    this.pool_key = cleanUserInput(config.pool_key);
    this.public = config.public;
    this.virtual = config.virtual;
  };
  function cleanUserInput(input) {
    if (typeof input !== 'string') {
      return '';
    }
    // Remove non-printable characters, including control characters
    return input.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  }
  RED.nodes.registerType('Bitpool-Pool-Settings', BitpoolPoolSettings);
}