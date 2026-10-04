const leftPad = require('left-pad');

function greet(name) {
  return leftPad(` hello ${name} `, 20);
}

module.exports = { greet };
