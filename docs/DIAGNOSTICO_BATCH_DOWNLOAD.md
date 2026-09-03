# Gemini Assistant - Diagnostico do Fluxo Batch + Download

Guia rapido para isolar onde o pipeline "carregar tasks -> gerar -> baixar -> renomear" esta falhando.

## Mapa do pipeline

```
project.json (Schema v3)
      |
      v parseProjectJson
[ src/lib/project.js ]  -- valida, expoe resolveTaskOutputBasename
      |
      v resolveReferences
[ src/lib/assets.js ]  -- File System Access API -> File objects
      |
      v runBatch()
[ src/workflow/orchestrator.js ]  -- Prepare -> Generate -> triggerDownload
      |
      v triggerAutoDownloadViaOfficialControl(cur)
[ src/sidepanel/sidepanel.js ]   -- arma SW com desiredFilename
      |                                          |
      |                                          v
      |           [ src/background/service-worker.js ]
      |            onDeterminingFilename -> suggest({ filename })
      |            onChanged -> DOWNLOAD_STATE_CHANGED
      v
[ chrome.downloads.download() ]   -- salva em
      |
Downloads/Gemini Assistant/<project-id>/<basename>.png
```

## Onde quebrar primeiro

| Sintoma | Suspeito principal | Como confirmar | Fix |
|---------|--------------------|---------------|-----|
| `Project files` mostra `X` para todas as refs | folder bound errado ou assets em pasta irma | `tests/references/` esta so para testes; refs do projeto vao em `<project-folder>/references/` | Re-bind no folder que contem `project.json` + `references/` |
| `Generate All Pending` nao aparece ou fica desabilitado | projeto nao tem tasks, ou todas ja `generated` | Abra DevTools -> Console e veja se `state.source.project` existe | Force `status` para `pending` no JSON ou use `Force regenerate` |
| Status line: `Downloading image...` trava > 90s e nada baixa | botao oficial do Gemini nao foi clicado (UI mudou), e o blob fallback tambem nao | Advanced Diagnostics -> Run Production Health Check + Run Download Event Probe | Veja secao "Health check report" abaixo |
| Imagem aparece no Gemini mas download baixa em `Downloads/` raiz como `Gemini_Generated_Image_xxx.png` | SW nao recebeu ARM_DOWNLOAD, ou nao matched o claim | Console: `[Gemini Assistant:sw download-trace]` deve mostrar `claim-received` e `onDeterminingFilename-fired` com `matched: true` | Recarregue a extensao; force `Reset Gemini Conversation` e tente de novo |
| 1a task passa, 2a task trava | `runBatch` nao reseta o chat antes da proxima | Console: deve aparecer `batch-reset-warning` se falhar | Clique em `Reset Gemini Conversation`; v0.10.x ja forca new-tab |
| Tasks avancam mas o arquivo sai com nome errado (ex: `task-001.png` em vez de `scene-001-first-snowfall.png`) | task sem `output.fileName` ou `title` no JSON | Inspecione o JSON | Adicione `output: { "fileName": "scene-001-primeira-neve" }` |

## Health check report (rodar sempre primeiro)

1. Abra o sidepanel sobre um tab `gemini.google.com`
2. Clique em **Advanced Diagnostics -> Run Production Health Check**
3. O painel mostra um relatorio com:
   - **SW**: registra 4 listeneres? (deve mostrar `downloadsOnCreated=1, onChanged=1, onDeterminingFilename=1`)
   - **Sidepanel -> SW messaging**: o ping funciona?
   - **Schema**: project JSON valido?
   - **Image mode**: Compose esta em modo "Create Image"?
   - **Composer**: limpo?
4. Se algum item estiver vermelho, esse e o ponto da falha

## Trace ao vivo (deep dive)

Quando o health check passa e mesmo assim o batch nao anda:

```
Advanced Diagnostics -> Run Download Event Probe
```

Esse botao dispara um ping ao service worker que devolve:
- `serviceWorkerRuntimeId` (deve mudar entre SW restarts)
- `downloadTrace.length` (deve crescer durante o batch)
- As ultimas 50 entradas do trace com timestamps e `executionId`/`taskId`

**O que procurar no trace:**

1. `download-claim-armed` (D0) - apareceu?
2. `service-worker-download-claim-received` (D7) - `result: accepted`?
3. `chrome.downloads.onCreated-fired` (D8) - `matched: true`?
4. `chrome.downloads.onDeterminingFilename-fired` (D9) - `result: ok`?
5. `filename-suggested` - `desiredFilename` e `Gemini Assistant/<project-id>/<basename>.png`?
6. `chrome-download-complete` - com `finalFilename` correto?

Se a cadeia quebra em qualquer um desses passos, esse e o ponto a investigar.

## Falsos negativos comuns

- **STALE DOWNLOAD CACHE**: o Chrome cacheia o "save as" location. Limpar Downloads recentes pode resetar o caminho. O SW usa `uniquify`, entao multiplos downloads da mesma task viram `<basename>.png`, `<basename> (1).png`, etc.
- **Service Worker recarregou entre claim e onChanged**: aborta o download sem renomear. O SW guarda `expectedDownloadClaims` em memoria - se ele reinicia, perde o claim. Recarregue a pagina e tente a task de novo.
- **Disco cheio**: download fica em estado `interrupted` em vez de `complete`. Verifique `~/Downloads/`.

## Smoke test rapido

Este comando roda no diretorio da extensao e valida que o pipeline inteiro de naming esta coerente:

```bash
/opt/homebrew/bin/node tests/run.js
```

Espera: `summary: 444 passed, 0 failed`. Se aparecer qualquer falha, ela e a causa raiz ou esta correlacionada.

## Compatibilidade do UI do Gemini (ATENCAO)

Os seletores do DOM do Gemini estao em constante mutacao. Os seguintes commits foram correcoes deste tipo:

- `v0.9.11 (e91b162)`: filtros `src^="blob:"` no detector - screenshots de upload nao sao geracoes reais
- `v0.9.10 (5d97442)`: batch precisa de Prepare Task explicito ou auto-prepare
- `v0.9.9 (ff3b676)`: batch precisa chamar `params.triggerDownload` apos cada `generateTask`
- `v0.9.8 (34c72a7)`: retry em batch precisa resetar conversa antes (Angular host poisoning)
- `v0.9.97`: deteccao estrita por `findCurrentGenerationImage` (so dentro do `model-response` apos baseline)

Se o Gemini atualizou o DOM apos o release atual da extensao, o caminho mais rapido e:

1. Abra DevTools e inspecione um `<model-response>` em `https://gemini.google.com/app`
2. Verifique se o botao de download ainda tem `aria-label="Baixar imagem no tamanho original"` (PT-BR) ou `Download image in original size` (EN)
3. Se mudou, edite `OFFICIAL_DOWNLOAD_ARIA_LABELS` em `src/dom/geminiDomAdapter.js:2889-2899`

## TL;DR - 5 passos para reproduzir e isolar

1. Carrega um exemplo limpo: `examples/example-project.json` (sem `references/`, o ideal e criar uma pasta dummy com PNGs validos)
2. Roda `Generate All Pending` com o Console aberto
3. Observe o first batch step no trace D0
4. Filtre no trace por `step=error` ou `result:rejected`
5. Use a tabela de sintomas acima para mapear o problema
