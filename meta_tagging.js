/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/

module.exports = function(RED) {
    function apptag(config) {        
        RED.nodes.createNode(this,config);
        var node = this;

        this.StreamTags = config.StreamTags;
        this.taglib = config.taglib;
        this.tagRegisters = config.tagRegisters;
        this.streamTagList = config.streamTagList;

        node.on('input', function(msg) {

            for(let i = 0; i < node.tagRegisters.length; i++) {
                let currentTag = node.tagRegisters[i];
                let filterArray = currentTag.filter.split(',');

                filterArray.forEach(item => {
                    let msgTopic = msg.topic.toLowerCase();
                    let itemName = item.toLowerCase().trim();
                    if(msgTopic.includes(itemName)) {
                        let existingTags = msg.StreamTags;
                        if(!existingTags) {
                            msg.StreamTags = currentTag.tagList;
                        } else if(!existingTags.includes(currentTag.tagList)) {
                            msg.StreamTags = existingTags + ", " + currentTag.tagList;
                        }
                    }
                });  
            };
            
            node.send(msg);

            node.status({fill:"green",shape:"dot",text:"Tags added to payload"});
        });
    }
    
    RED.nodes.registerType("metatag", apptag);
}