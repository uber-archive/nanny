var test = require('tape');

var clustermon = require('../index.js');

test('clustermon is a function', function (assert) {
    assert.strictEqual(typeof clustermon, 'function');
    assert.end();
});
