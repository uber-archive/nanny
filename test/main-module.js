// Worker fixture for main-module-test.
'use strict';
process.send({cmd: 'TEST_RESULT', result: require.main === module});
