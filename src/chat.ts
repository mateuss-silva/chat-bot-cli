import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { History, loadAssets } from './context.js';
import { ApiRequester } from './transport.js';
import { executeTurn } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const assets = await loadAssets();
  const requester = new ApiRequester(config);
  const history = new History();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let busy = false;
  let closed = false;
  let critic = false;
  let pending: string | undefined;
  let controller: AbortController | undefined;
  let count = 0;
  const help = () => console.log('/help  /exit  /clear  /retry  /critic on|off\nCtrl+C encerra e cancela a solicitação ativa. Histórico apenas em memória (20 turnos completos).');
  const prompt = () => { if (!closed && !busy) rl.prompt(); };
  const close = () => { closed = true; controller?.abort(); rl.close(); };
  rl.setPrompt('Você> ');
  console.log('Suporte fictício em português brasileiro. Nenhuma ação bancária ou contato humano é realizado.');
  help();
  rl.on('SIGINT', close);
  process.on('SIGINT', close);
  rl.on('close', () => { closed = true; controller?.abort(); });
  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line === '/exit') { close(); return; }
    if (busy) { console.log('Aguarde a solicitação atual; use /exit ou Ctrl+C para cancelar.'); return; }
    if (!line) { prompt(); return; }
    if (line === '/help') { help(); prompt(); return; }
    if (line === '/clear') { history.clear(); pending = undefined; console.log('Histórico limpo.'); prompt(); return; }
    if (/^\/critic (on|off)$/.test(line)) {
      critic = line.endsWith(' on');
      console.log(critic ? 'Revisão ativada: uma chamada adicional após a resposta, com maior latência e uso da API. A resposta inicial já será visível.' : 'Revisão desativada.');
      prompt(); return;
    }
    if (line.startsWith('/') && line !== '/retry') { console.log('Comando inválido. Consulte /help.'); prompt(); return; }
    if (line === '/retry' && !pending) { console.log('Não há solicitação incompleta para repetir.'); prompt(); return; }
    const message = line === '/retry' ? pending! : line;
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    process.stdout.write('Assistente> ');
    void executeTurn(requester, assets, history, message, {}, critic, `interactive-turn-${++count}`, signal,
      text => process.stdout.write(text)).then(record => {
      console.log();
      if (record.status !== 'complete') {
        pending = message;
        console.log(`[${record.status === 'incomplete' ? 'Resposta incompleta; não armazenada' : 'Erro'}] ${record.initial.error} Use /retry para uma nova tentativa explícita.`);
      } else {
        pending = undefined;
        if (record.revisedOutput !== 'unavailable') console.log(`Resposta revisada:\n${record.revisedOutput}`);
        if (record.critic?.error) console.log(record.critic.error);
      }
    }).catch(() => {
      pending = message;
      console.log('\nErro ao processar a solicitação. Use /retry.');
    }).finally(() => { busy = false; controller = undefined; prompt(); });
  });
  prompt();
}

main().catch(error => {
  console.error(error instanceof Error && /^(Configure|Configuração|Arquivo|Políticas|Fixture)/.test(error.message) ? error.message : 'Não foi possível iniciar. Verifique configuração e arquivos locais.');
  process.exitCode = 1;
});
