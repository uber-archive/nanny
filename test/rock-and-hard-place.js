'use strict';

// This module pits a cluster of aggressive clients against a cluster of flaky
// servers.

var path = require('path');
var ClusterSupervisor = require('../cluster-supervisor');

var supervisor = new ClusterSupervisor({
    exec: path.join(__dirname, 'rock-or-hard-place.js'),
    logicalIds: ['rock', 'hard-place'],
    createEnvironment: function (logicalId) {
        return {
            NODE_DEBUG: 'clustermon',
            HODOR_PORT: 2020,
            ROLE: logicalId
        };
    },
    workerForceStopDelay: 5000
})

supervisor.start();

