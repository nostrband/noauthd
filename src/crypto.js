const { pbkdf2, randomBytes } = require('node:crypto');

const ITERATIONS = 10000
const SALT_SIZE = 16
const HASH_SIZE = 32
const HASH_ALGO = 'sha256'

async function makePwh2(pwh, salt) {
  return new Promise((ok, fail) => {
    salt = salt || randomBytes(SALT_SIZE)
    pbkdf2(pwh, salt, ITERATIONS, HASH_SIZE, HASH_ALGO, (err, hash) => {
      if (err) fail(err)
      else ok({ pwh2: hash.toString('hex'), salt: salt.toString('hex') })
    })    
  })
}

module.exports = {
  makePwh2
}