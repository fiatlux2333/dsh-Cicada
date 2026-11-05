if (!process.send || !process.env.CICADA_FIXTURE_NONCE)
  throw new Error('This preloader requires an owned test Host IPC channel');

const nonce = process.env.CICADA_FIXTURE_NONCE;
delete process.env.CICADA_FIXTURE_NONCE;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // Deliver the ordinary CLI's bounded disposal signal without Windows TerminateProcess.
  if (!process.emit('SIGTERM')) process.exit(1);
}
process.on('message', (message) => {
  if (message?.kind === 'cicada-fixture-stop' && message.nonce === nonce) stop();
});
process.on('disconnect', stop);
process.channel.unref();
