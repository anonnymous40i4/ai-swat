# KROK C — Abacus.ai Multi-Agent Orchestration

**Status implementacji:** graf Master Agenta, kontrakty JSON, migracja outboxa i cztery Edge Functions są w repo. Brak kluczy Abacus/Supabase w sandboxie oznacza brak rzeczywistego wdrożenia na konta produkcyjne.

## C.0 Decyzje twarde

1. **Supabase pozostaje systemem prawdy**: użytkownicy, zgody, evidence, wektory, PoS, Matches, blokady, pushe i audyt.
2. **Abacus jest tylko procesorem obliczeniowym roju**: pobiera pseudonimową paczkę kandydatów, liczy ranking i odsyła propozycję. Nie zapisuje dopasowania bezpośrednio i nie ma `service_role`.
3. **Bez RAG dla wektorów.** Abacus AI Workflow obsługuje węzły Python/LLM, ale 32 liczby nie są dokumentami do retrievemu. Nie tworzymy Feature Group, Datasetu ani Database Connectora z wektorami — to dublowałoby profil poza Supabase.
4. **Telefon nigdy nie woła Abacus** i nie zna `deploymentId`, `deploymentToken`, sekretu HMAC ani adresów callbacku.
5. Pierwsze zdarzenie do Abacus zawiera tylko `swarm_uid` i metadane. Wektor jest pobierany natychmiast z Supabase, więc stare/nieważne zdarzenie nie liczy na nieaktualnym profilu.
6. Abacus może widzieć pseudonimowe wektory w pamięci węzłów i ich wyjściach workflow. Przed produkcją trzeba zweryfikować w umowie/DPA i ustawieniach projektu retencję historii wykonań oraz logów. To bramka wdrożeniowa, nie detal.

## C.1 Drzewo agentów i pipeline

```text
TELEFON
  LLaMA + ewaluator
      │  JWT usera; maks. 10 liczbowych evidence/sesję
      ▼
SUPABASE ingest-evidence
  agregacja trait_scores -> swarm_vectors + PoS
      │  trigger w tej samej transakcji DB
      ▼
swarm_events_outbox (VECTOR_READY / VECTOR_UPDATED / POS_PASSED)
      │  Edge Function swarm-dispatch, claim FOR UPDATE SKIP LOCKED
      │  POST executeAgent (deploymentToken wyłącznie serwerowo)
      ▼
ABACUS: MASTER SWAT AGENT (AI Workflow, Online Deployment)
  [0 Intake]                     waliduje UUID/wersję/idempotencję
      ▼
  [A FetchCandidateBundle]       HMAC POST -> Supabase swarm-candidates
      │                            fn_swarm_candidate_bundle(): ANN pgvector, top 200
      ▼
  [B Eligibility/Dealbreaker]    maski, PoS już przefiltrowane, język/region/wiek/dealbreakery
      ▼
  [C CosineReranker]             maskowany cosinus per kategoria -> top 3 propozycje >= 0.78
      ▼
  [D CallbackToSupabase]         HMAC POST -> abacus-match-callback, bez wektorów
      ▼
SUPABASE abacus-match-callback
  rewalidacja bundle -> insert Matches -> match_notifications -> Expo Push
      ├──> APNs/FCM (telefon w tle)
      └──> Supabase Realtime/polling (telefon aktywny)
```

Agenty poboczne są celowo poza ścieżką krytyczną:

| Workflow | Interfejs | Zadanie | Uprawnienia |
|---|---|---|---|
| `Master Swat Agent` | `DEFAULT`, Online Deployment | ranking 1 profil → top 200 → top 3 | opisane niżej per węzeł |
| `Swarm Sweeper` (roadmap) | `AUTONOMOUS`, Loop Node co 15 min | ponowne wywołanie dispatchera dla martwych claimed events; nie liczy samodzielnie | tylko endpoint status/dispatch z osobnym sekretem |
| `Calibration Analyst` (roadmap) | harmonogram tygodniowy | raport z agregatów `match_feedback`, propozycja zmiany wag | wyłącznie agregaty; zmiana wag tylko po akceptacji człowieka i nowej wersji Mastera |

Nie ma węzła LLM w Masterze. Ewentualny tekst wyjaśnienia dopasowania jest generowany z komponentów deterministycznie po stronie aplikacji.

## C.2 Izolacja węzłów Abacus

| Węzeł | Plik/funkcja | Wejście | Wyjście | Sieć | Sekrety organizacji |
|---|---|---|---|---|---|
| 0 Intake | `master_nodes.intake` | pola zdarzenia | `event_json` | brak | brak |
| A Fetch | `fetch_candidate_bundle` | `event_json` | `bundle_json` | tylko Supabase `swarm-candidates` | `SWARM_CANDIDATES_URL`, `SWARM_SHARED_SECRET` |
| B Filter | `filter_candidates` | `bundle_json` | źródło + przefiltrowana lista, liczniki odrzuceń | brak | brak |
| C Score | `score_candidates` | źródło + kandydaci | `result_json` bez embeddingów | brak | brak |
| D Callback | `callback_result` | `event_json`, `result_json` | decision/status | tylko Supabase `abacus-match-callback` | `SWARM_CALLBACK_URL`, `SWARM_SHARED_SECRET` |

Każda funkcja węzła ma importy wewnątrz ciała. To wymóg serializacji Abacus Workflow. Węzły nie logują payloadów; błędy HTTP zwracają tylko kod statusu.

## C.3 Procedura deva: ustawienie Abacus krok po kroku

### 1. Projekt i sekrety organizacji

W Abacus utwórz projekt typu **AI Workflow**. Nie podłączaj Supabase jako Database Connector.

Utwórz sekrety organizacji (UI organizacji albo Python SDK; wartości z menedżera sekretów, nigdy z repo):

```python
from abacusai import ApiClient

client = ApiClient("<ABACUS_API_KEY_Z_SEKRETÓW_CI>")
client.create_organization_secret(
    "SWARM_CANDIDATES_URL",
    "https://<SUPABASE_REF>.supabase.co/functions/v1/swarm-candidates",
)
client.create_organization_secret(
    "SWARM_CALLBACK_URL",
    "https://<SUPABASE_REF>.supabase.co/functions/v1/abacus-match-callback",
)
client.create_organization_secret("SWARM_SHARED_SECRET", "<min. 32 losowe bajty>")
```

### 2. Zbuduj i zweryfikuj graf

```bash
cd orchestration/abacus
python -m pip install abacusai requests

# bez sieci: konstrukcja WorkflowGraph i lokalny podgląd węzłów
python build_workflow.py

# walidacja po stronie Abacus
ABACUS_API_KEY=... python build_workflow.py --validate

# utworzenie agenta w projekcie
ABACUS_API_KEY=... ABACUS_PROJECT_ID=... python build_workflow.py --create
```

Graf buduje `WorkflowGraph` w trybie `data_flow`, węzły łączy mapowaniami `.outputs.*`, a wejście Intake opisuje `WorkflowNodeInputSchema` zgodny z `contracts/abacus_swarm_event.schema.json`.

### 3. Online Deployment i Predictions API

W UI Abacus:

1. Otwórz utworzonego agenta.
2. Utwórz **Online Deployment**.
3. Wejdź w **Predictions API** deploymentu.
4. Skopiuj `deploymentId` i wygeneruj `deploymentToken`.
5. Zapisz je wyłącznie jako sekrety Supabase z pkt C.5.

Wywołanie `executeAgent` jest udokumentowane jako `POST https://api.abacus.ai/api/executeAgent` z `deploymentToken`, `deploymentId`, `arguments` i `keywordArguments`. Nasz dispatcher wysyła dokładnie ten kształt.

Opcjonalny wariant triggera webhookowego (`AUTONOMOUS` + `WebhookTriggerConfig`) nie jest ścieżką główną: sygnał webhooka nie daje tak precyzyjnego mapowania argumentów eventu jak `executeAgent`, a publiczny URL wymagałby osobnego endpointu pobierania zaległych eventów. Główny kanał ma natomiast deterministyczne potwierdzenie wykonania i retry z outboxa.

## C.4 Dokładny przebieg wymiany Supabase ↔ Master

### Krok 1: telefon domyka paczkę evidence

`ingest-evidence` weryfikuje JWT, odrzuca pola spoza kontraktu, zapisuje maksymalnie przydzielone paczki evidence, agreguje cechy i upsertuje `swarm_vectors`. Trigger `trg_swarm_vector_event` albo `trg_pos_passed_event` wstawia zdarzenie do `swarm_events_outbox` w tej samej transakcji. Starsze, jeszcze niewysłane eventy tego samego UID dispatcher oznacza jako `superseded`.

### Krok 2: dispatcher claimuje i wywołuje Abacus

Harmonogram co minutę woła `swarm-dispatch` z nagłówkiem `x-dispatch-secret`. Funkcja RPC `fn_claim_swarm_events` blokuje wiersze `FOR UPDATE SKIP LOCKED`, a Edge Function wysyła:

```http
POST https://api.abacus.ai/api/executeAgent?deploymentToken=...&deploymentId=...
Content-Type: application/x-www-form-urlencoded

arguments=[]
keywordArguments={
  "event_id":"...",
  "event_type":"VECTOR_READY",
  "swarm_uid":"...",
  "vector_version":"vec-v1",
  "idempotency_key":"...",
  "issued_at":"2026-10-18T..."
}
```

### Krok 3: Master pobiera kandydatów

Węzeł A podpisuje żądanie `HMAC-SHA256(secret, timestamp + "." + raw_body)` i woła `swarm-candidates`. Edge Function sprawdza podpis i 300-sekundowe okno czasu, po czym RPC `fn_swarm_candidate_bundle`:

- sprawdza źródło: status `ready_for_swarm`, PoS `passed` i niewygasły, `coverage >= 0.75`;
- pobiera top 200 przez istniejące `fn_find_candidates` (pgvector cosine ANN);
- odrzuca blokady w obie strony oraz istniejące, nierozstrzygnięte/odrzucone pary;
- zwraca źródło i kandydatów: embedding 32, maskę hard-pointów, pewność, region/pasmo wieku i ograniczenia;
- nie zwraca `user_id`, transkryptów, wyników bramek PoS ani żadnych danych cywilnych.

### Krok 4: węzeł B usuwa twarde niezgodności

Bramki wykonywane przed rankingiem:

- embedding dokładnie 32 skończone liczby z zakresu `[-1,1]`;
- overlap masek co najmniej 24/32; wszystkie wymiary zamiaru 0–4 twarde u obu stron;
- minimalny overlap kategorii: wartości 3, komunikacja 3, styl/praktyczne 8;
- wspólny język;
- region zgodny z zakresem obu stron (`same_city` = pełny `region_code`, województwo = dwa pierwsze segmenty, kraj = pierwszy);
- pasma wieku zgodne wzajemnie, jeśli podane;
- dealbreakery: przeciwstawny zamiar, konflikt planów długoterminowych, alkohol i zwierzęta według kluczy z kontraktu bundla.

### Krok 5: węzeł C liczy cosinus 1-na-1

Dla każdego kandydującego profilu liczony jest cosinus wyłącznie na przecięciu twardych wymiarów kategorii:

```text
cos_k = Σ(a_i·b_i) / (||a||·||b||), i ∈ overlap(mask_a, mask_b) ∩ kategoria_k

S = 0.30·cos_intent(0-4)
  + 0.25·cos_values(5-10)
  + 0.25·cos_communication(11-16)
  + 0.20·cos_lifestyle(17-31)
```

Norma zerowa w kategorii daje `0.0`, nie fałszywą zgodność. Sortowanie: najwyższe `S`, potem większa pewność, potem `swarm_uid` dla deterministyczności. Dopiero `S >= 0.78` przechodzi do propozycji. Agent odsyła top 3, ponieważ pierwsza para może zniknąć z eligibilności do czasu callbacku.

Wynik UI jest mapowany tak samo jak w Supabase: `80 + 20·(S-0.78)/0.22`, zaokrąglony i ograniczony do 99.

### Krok 6: callback i ostateczna decyzja w Supabase

Węzeł D podpisuje `master-result-v1` HMAC-em i wysyła go do `abacus-match-callback`. Supabase:

1. weryfikuje podpis i zgodność eventu;
2. deduplikuje po `run_ref` (`uq_abacus_runs_external_ref`);
3. dla `MATCHED` ponownie pobiera żywy bundle — kandydat musi nadal być widoczny po filtrach PoS/blokad/istniejących par;
4. sama przelicza `display_score`, nie ufa liczbie z Abacus;
5. kanonizuje parę `swarm_a < swarm_b` i wstawia match;
6. tworzy po jednym `match_notifications` dla odbiorcy;
7. wysyła Expo Push do aktywnych urządzeń obu stron;
8. aktualizuje `abacus_runs`, `match_runs`, `audit_log` i potwierdza event outboxa.

Przykładowa treść pusha: **„Znalazłem kandydata — zgodność zamiarów i wartości: 95/100”**. Nie używamy sformułowania „95% szans”.

## C.5 Sekrety i harmonogram Supabase

```bash
supabase secrets set \
  SWARM_SHARED_SECRET='...' \
  DISPATCH_SECRET='...' \
  ABACUS_MASTER_DEPLOYMENT_ID='...' \
  ABACUS_DEPLOYMENT_TOKEN='...'

supabase functions deploy ingest-evidence swarm-candidates swarm-dispatch abacus-match-callback
supabase db push
```

Cron wywołujący dispatchera należy skonfigurować w konkretnym projekcie Supabase (pg_cron + `pg_net` albo Scheduled Functions), z URL i `DISPATCH_SECRET` pobieranymi z Vault. Nie wpisujemy tych wartości do migracji. Dispatcher przetwarza domyślnie sześć eventów na wywołanie, w paczkach współbieżnych po trzy, z timeoutem 45 s na `executeAgent`.

Retry:

- claim zwiększa `attempts`; utknięty claim po 10 minutach wraca do puli;
- błąd ustawia `failed` i backoff `30s · 2^attempts`, maks. 1 h;
- po 8 próbach event jest `dead` i wymaga interwencji/alertu;
- duplikat callbacku po `run_ref` zwraca istniejący wynik;
- duplikat pary jest blokowany przez unikalność `(swarm_a, swarm_b)`.

## C.6 Testy lokalne wykonane dla tego kroku

- Python: `build_workflow.py` konstruuje graf 5 węzłów przy użyciu zainstalowanego SDK Abacus.
- Jednostkowo przetestowano Intake → Filter → Score na syntetycznym bundlu: kandydat z innego regionu odrzucony, para równoległych wektorów daje `MATCHED`, `display_score = 99`.
- SQL: migracje 0001+0002 wykonane na lokalnym Postgresie ze stubami auth/pgvector; trigger tworzy event, claim zostawia tylko najnowszy event UID, finish ustawia `acked`.
- TypeScript: składnia wszystkich Edge Functions przetestowana parserem TS. Sandbox nie mógł pobrać binarki Deno, więc `deno check` trzeba wykonać w CI/środowisku z dostępem do release Deno.

## Dokumentacja źródłowa Abacus

- AI Workflows i budowa `WorkflowGraph`: https://abacus.ai/help/python-sdk/genai/ai-workflows/
- `executeAgent`: https://abacus.ai/help/developer-platform/api/ref/ai_agents/executeAgent
- AI Workflow / Online Deployment: https://abacus.ai/help/developer-platform/useCases/AI_AGENTS
