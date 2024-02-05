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

function countLeadingZeros(hex) {
  let count = 0;

  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) {
      count += 4;
    } else {
      count += Math.clz32(nibble) - 28;
      break;
    }
  }

  return count;
}

module.exports = {
  makePwh2,
  countLeadingZeros
}