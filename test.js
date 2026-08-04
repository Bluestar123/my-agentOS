import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin
});

rl.on('line', (text) => {
    console.log('管道数据：', text);
});

rl.on('close', () => {
    console.log('流关闭');
});