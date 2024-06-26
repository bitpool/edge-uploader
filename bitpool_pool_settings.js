/*
  MIT License Copyright 2021-2024 - Bitpool Pty Ltd
*/


'use strict'

module.exports = function (RED) {
    function BitpoolPoolSettings (config) {
      RED.nodes.createNode(this, config);
      this.name = config.name;
      this.pool_name = config.pool_name;
      this.pool_key = config.pool_key;
      this.public = config.public;
      this.virtual = config.virtual;
    };
    RED.nodes.registerType('Bitpool-Pool-Settings', BitpoolPoolSettings);
  }