'use strict';

var tape = require('tape');
var path = require('path');
var ClusterSupervisor = require('../cluster-supervisor');

tape('worker should receive same process.argv as non-worker', function (assert) {

    var workerPath = path.join(__dirname, 'worker-argv.js');

    var supervisor = new ClusterSupervisor({
        workerPath: workerPath,
        workerArgv: ['--arg'],
        execArgv: ['--harmony'],
        workerCount: 1
    });

    supervisor.start();
    supervisor.workers[0].on('message', function (message) {
        if (message.cmd === 'TEST_RESULT') {
            assert.strictEqual(message.result.length, 3);
            assert.strictEqual(message.result[1], workerPath);
            assert.strictEqual(message.result[2], '--arg');
            supervisor.stop(function () {
                assert.end();
            });
        }
    });

});

