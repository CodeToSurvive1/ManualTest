var path = require('path')
var fs = require('fs')
var util = require('util')
// Export
module.exports.module = function(target) {
  return path.resolve(__dirname, '../node_modules', target)
}


// Export
module.exports.vendor = function(target) {
  return path.resolve(__dirname, '../vendor', target)
}
