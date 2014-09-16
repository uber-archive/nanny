var Clustermon = require('../index.js');
var test = require('tape');

test('init Clustermon with logical IDs', function (assert) {
    var nc = new Clustermon({
        respawnWorkerCount: 1,
        exec: __dirname + '/mock_server.js',
        numCPUs: 8,
        logicalIds: [11, 12, 13, 14, 15, 16, 17, 18]
    });
    var cluster = nc.start();

    if (cluster) {
        assert.strictEqual(Object.keys(cluster.workers).length, 8);

        setTimeout(function() {
            Object.keys(cluster.workers).forEach(function (id) {
                cluster.workers[id].kill();
            });

            assert.strictEqual(Object.keys(cluster.workers).length, 0);

            setTimeout(function() {
                Object.keys(cluster.workers).forEach(function (id) {
                    cluster.workers[id].kill();
                });

                assert.end();
            }, 1000);
        }, 1000);
    }
});
