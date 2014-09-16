var Clustermon = require('../index.js');
var test = require('tape');

test('extended init Clustermon', function (assert) {
    var nc = new Clustermon({
        initMaster: function () {
            assert.equal(true, true);
        },
        exec: __dirname + '/mock_server.js',
        respawnWorkerCount: 0,
        numCPUs: 8
    });
    var cluster = nc.start();

    if (cluster) {
        setTimeout(function () {
            Object.keys(cluster.workers).forEach(function (id) {
                cluster.workers[id].kill();
            });

            assert.end();
        }, 1000);
    }
});
