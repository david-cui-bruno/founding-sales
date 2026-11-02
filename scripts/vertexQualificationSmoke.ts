// Local smoke of prepared-prospect qualification on Vertex AI (gemini-3.8-flash), with the operator's
// application-default credentials instead of the worker's AWS federation. Makes real, billed
// calls (about 2 cents each); run it by hand, never in CI.
//
//   node --experimental-transform-types scripts/vertexQualificationSmoke.ts \
//     "Firm Name|City|MA|https://firm.example/,https://firm.example/about" [...]
//
// Needs `gcloud auth application-default login` and FSS_VERTEX_PROJECT (default colormyworld-prod-dc824).
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parsePageText} from '@fss/domain/research/pageText.ts';
import {QUALIFICATION_OUTPUT_TOKENS,QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE,type QualificationExtractionRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {QUALIFICATION_MODEL_NAME,qualificationReservationCents} from '@fss/domain/sourcing/qualificationModel.ts';
import {qualificationExtraction} from '../apps/worker/src/sourcing/qualificationExtraction.ts';
import {vertexGeminiSurface,type GeminiResponse,type GeminiSurface} from '../apps/worker/src/sourcing/vertexGemini.ts';

const project = process.env.FSS_VERTEX_PROJECT ?? 'colormyworld-prod-dc824';
const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {encoding: 'utf8'}).trim();
const vertex = vertexGeminiSurface({project, location: 'global', accessToken: async () => token});
let last: GeminiResponse | undefined;
const surface: GeminiSurface = {countTokens: request => vertex.countTokens(request), generate: async request => (last = await vertex.generate(request))};

for (const argument of process.argv.slice(2)) {
  const [firmName = '', locality = '', region = '', urls = ''] = argument.split('|');
  const observations: QualificationExtractionRequest['observations'][number][] = [];
  for (const url of urls.split(',').filter(Boolean)) {
    const response = await fetch(url, {headers: {'user-agent': 'Mozilla/5.0 (compatible; CallieSmoke/1.0)'}, signal: AbortSignal.timeout(20_000)});
    const body = new Uint8Array(await response.arrayBuffer());
    const page = parsePageText(body, response.headers.get('content-type') ?? 'text/html');
    if (page.blocks.length === 0) continue;
    observations.push({id: randomUUID(), url, contentHash: createHash('sha256').update(body).digest('hex'), relevantTextHash: createHash('sha256').update(page.text).digest('hex'), retrievedAt: new Date().toISOString(), publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: page.truncated, blocks: [...page.blocks]});
  }
  const input: QualificationExtractionRequest = {candidate: {firmName, locality, region: region as 'MA', website: urls.split(',')[0] ?? ''}, observations, modelName: QUALIFICATION_MODEL_NAME, maxInputTokens: 200_000, maxOutputTokens: QUALIFICATION_OUTPUT_TOKENS};
  const provider = qualificationExtraction(surface);
  const counted = await provider.countInputTokens(input);
  const started = Date.now();
  const outcome = await provider.extract(input);
  const actual = last?.usageMetadata;
  console.error(JSON.stringify({
    firm: firmName, pages: observations.length, truncatedPages: observations.filter(observation => observation.truncated).length, blocks: observations.reduce((total, observation) => total + observation.blocks.length, 0),
    countedInputTokens: counted, countedMinusActual: counted - (actual?.promptTokenCount ?? 0), allowance: QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE,
    usage: actual, finishReason: last?.candidates?.[0]?.finishReason, secondsForOneCall: (Date.now() - started) / 1000,
    reservedCents: qualificationReservationCents(QUALIFICATION_MODEL_NAME, {inputTokens: counted, outputTokens: QUALIFICATION_OUTPUT_TOKENS}, new Date().toISOString()),
    settledCents: outcome.costCents, ok: outcome.ok,
    selections: outcome.ok ? outcome.value.facts.map(fact => ({kind: fact.kind, blockId: 'blockId' in fact ? fact.blockId : undefined, value: String(fact.value).slice(0, 90)})) : outcome,
    modelSelections: (JSON.parse(last?.candidates?.[0]?.content?.parts?.find(part => part.text !== undefined && part.thought !== true)?.text ?? '{}') as {selections?: {kind: string; blockId: string}[]}).selections?.map(selection => selection.kind + ':' + selection.blockId),
    openingQuestion: outcome.ok ? outcome.value.openingQuestion : undefined,
  }, null, 1));
}
