import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { History, loadAssets } from './context.js';
import { MemoryRepository, type Session } from './memory-repository.js';
import { ApiRequester } from './transport.js';
import { executeTurn } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const assets = await loadAssets();
  const requester = new ApiRequester(config);
  const repository = new MemoryRepository(config.databasePath);
  const history = new History(config.historyLimit);
  let session: Session;
  try {
    session = repository.createSession();
  } catch (error) { repository.close(); throw error; }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let busy = false;
  let closed = false;
  let critic = false;
  let pending: { id: string; message: string } | undefined;
  let controller: AbortController | undefined;
  const help = () => console.log('/help  /exit  /clear  /retry  /critic on|off  /session  /new  /resume <id>\n' +
    `Histórico local: até ${history.limit} turnos recentes e ${config.memoryLimit} turnos antigos relevantes. Ctrl+C encerra.`);
  const prompt = () => { if (!closed && !busy) rl.prompt(); };
  const closeDatabase = () => { if (closed && !busy) repository.close(); };
  const close = () => { closed = true; controller?.abort(); rl.close(); closeDatabase(); };
  rl.setPrompt('Você> ');
  console.log('Suporte fictício em português brasileiro. Nenhuma ação bancária ou contato humano é realizado.');
  console.log(`Sessão: ${session.id}`);
  help();
  rl.on('SIGINT', close);
  process.on('SIGINT', close);
  rl.on('close', () => { closed = true; controller?.abort(); closeDatabase(); });
  const handleLine = (raw: string) => {
    if (closed) return;
    const line = raw.trim();
    if (line === '/exit') { close(); return; }
    if (busy) { console.log('Aguarde a solicitação atual; use /exit ou Ctrl+C para cancelar.'); return; }
    if (!line) { prompt(); return; }
    if (line === '/help') { help(); prompt(); return; }
    if (line === '/session') { console.log(`Sessão: ${session.id}`); prompt(); return; }
    if (line === '/clear') {
      repository.clearSession(session.id);
      history.clear(); pending = undefined;
      console.log('Histórico da sessão limpo no banco local.'); prompt(); return;
    }
    if (line === '/new') {
      session = repository.createSession();
      history.clear(); pending = undefined;
      console.log(`Nova sessão: ${session.id}`); prompt(); return;
    }
    if (/^\/resume(?:\s|$)/.test(line)) {
      const id = line.slice('/resume'.length).trim();
      if (!id) { console.log('Uso: /resume <id>'); prompt(); return; }
      if (!repository.getSession(id)) { console.log('Sessão não encontrada.'); prompt(); return; }
      const turns = repository.getRecentTurns(id, history.limit);
      session = repository.setActiveSession(id);
      history.replace(turns); pending = undefined;
      console.log(`Sessão retomada: ${session.id}`); prompt(); return;
    }
    if (/^\/critic (on|off)$/.test(line)) {
      critic = line.endsWith(' on');
      console.log(critic ? 'Revisão ativada: uma chamada adicional após a resposta, com maior latência e uso da API. A resposta inicial já será visível.' : 'Revisão desativada.');
      prompt(); return;
    }
    if (line.startsWith('/') && line !== '/retry') { console.log('Comando inválido. Consulte /help.'); prompt(); return; }
    if (line === '/retry' && !pending) { console.log('Não há solicitação incompleta para repetir.'); prompt(); return; }
    const turn = line === '/retry' ? pending! : { id: randomUUID(), message: line };
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    process.stdout.write('Assistente> ');
    void executeTurn(requester, assets, history, turn.message, {}, critic, turn.id, signal,
      text => process.stdout.write(text), { repository, sessionId: session.id,
        limit: config.memoryLimit, maxChars: config.memoryMaxChars }).then(record => {
      console.log();
      if (record.persistenceError) console.log(record.persistenceError);
      if (record.status !== 'complete') {
        pending = turn;
        console.log(`[${record.status === 'incomplete' ? 'Resposta incompleta; fora do histórico' : 'Erro'}] ${record.initial.error} Use /retry para uma nova tentativa explícita.`);
      } else {
        pending = undefined;
        if (record.revisedOutput !== 'unavailable') console.log(`Resposta revisada:\n${record.revisedOutput}`);
        if (record.critic?.error) console.log(record.critic.error);
      }
    }).catch(error => {
      pending = turn;
      console.log('\n' + (error instanceof Error && error.message.startsWith('Não foi possível preparar a memória local.')
        ? error.message : 'Erro ao processar a solicitação.') + ' Use /retry.');
    }).finally(() => { busy = false; controller = undefined; closeDatabase(); prompt(); });
  };
  rl.on('line', raw => {
    try { handleLine(raw); }
    catch { console.log('Não foi possível concluir a operação no banco local.'); prompt(); }
  });
  prompt();
}

main().catch(error => {
  console.error(error instanceof Error && /^(Configure|Configuração|Arquivo|Políticas|Fixture)/.test(error.message) ? error.message :
    'Não foi possível iniciar. Verifique configuração, arquivos e acesso ao banco local.');
  process.exitCode = 1;
});
