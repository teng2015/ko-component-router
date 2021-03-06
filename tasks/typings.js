'use strict'

const path = require('path')
const spawn = require('cross-spawn')

module.exports = function * () {
  yield new Promise((resolve) => {
    const tsc = spawn('tsc', [
      '--declaration', 'true',
      '--declarationDir', path.resolve(__dirname, '../dist/typings')
    ], { stdio: 'inherit' })
    tsc.on('close', resolve)
  })
}
