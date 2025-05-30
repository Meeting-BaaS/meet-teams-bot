import * as crypto from 'crypto'

function generateExtensionKey(): string {
    // Générer une paire de clés RSA
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem',
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
        },
    })

    // Extraire seulement la partie base64 de la clé publique
    const pemContents = publicKey
        .toString()
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\n/g, '')

    console.log('\nCopy this exact line into your manifest.json:')
    console.log(`"key": "${pemContents}"`)

    return pemContents
}

const key = generateExtensionKey()
console.log(
    key,
    'copy to manifest.json then load the extension to get the extension_id and put it in the recording_server',
)
