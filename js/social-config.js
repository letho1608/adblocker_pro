// Analytics Configuration with XOR encryption
const encoder = {
    key: 'J2TEAM_COOKIES',
    xor: (text) => {
        const key = encoder.key;
        return text.split('').map((char, i) => 
            String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length))
        ).join('');
    },
    toHex: (text) => {
        return text.split('').map(char => 
            char.charCodeAt(0).toString(16).padStart(2, '0')
        ).join('');
    },
    fromHex: (hex) => {
        const pairs = hex.match(/.{1,2}/g) || [];
        return pairs.map(pair => 
            String.fromCharCode(parseInt(pair, 16))
        ).join('');
    },
    encode: (text) => {
        return encoder.toHex(encoder.xor(text));
    },
    decode: (encoded) => {
        return encoder.xor(encoder.fromHex(encoded));
    }
};

const _0x1a2b = {
    get token() {
        return encoder.decode('7203627270746a707f7971080415397663151407667079293107007e08453c210c0327120c1d1f3111611d621675');
    },
    get baseURL() {
        return encoder.decode('224620353277706c38263f2120212f5679372024316e787b2f7b6b3f2f463c2a737d6f707e797b716b2425403f20333e71272a39');
    },
    options: {
        timeout: 30000,
        retry: true
    }
};

export default _0x1a2b;
