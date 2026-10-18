# KROK D — Szkielet Expo / React Native

**Lokalizacja:** `apps/mobile`  
**Stack:** Expo SDK 58, React Native 0.88, React 19.3, Expo Router, TypeScript strict, Supabase JS.

Aplikacja działa bez backendu w trybie **DEMO lokalnego**. Po ustawieniu `.env` używa Supabase Auth, RLS, Edge Function `ingest-evidence`, Realtime i Expo Push.

## D.1 Struktura plików

```text
apps/mobile/
├── app.json
├── babel.config.js
├── package.json                      # main = expo-router/entry
├── .env.example
└── src/
    ├── app/                          # wyłącznie trasy Expo Router
    │   ├── _layout.tsx               # providery + niewidzialne gate'y
    │   ├── index.tsx                 # redirect: auth -> zgody -> czat
    │   ├── (auth)/
    │   │   ├── _layout.tsx
    │   │   ├── sign-in.tsx
    │   │   └── onboarding.tsx
    │   └── (tabs)/
    │       ├── _layout.tsx
    │       ├── chat.tsx              # messenger z Osobistym Agentem
    │       ├── matches.tsx           # wynik Mastera, karta 80-99
    │       ├── privacy.tsx           # lokalne dane / kolejka / egress
    │       └── profile.tsx           # status, preferencje, pauza
    ├── components/
    │   ├── ChatBubbles.tsx           # memoizowane bąbelki + composer
    │   ├── MatchCard.tsx
    │   ├── TelemetrySyncGate.tsx     # renderuje null; NetInfo/AppState -> sync
    │   └── MatchRealtimeGate.tsx     # renderuje null; push/Realtime/polling
    ├── config/env.ts
    ├── contracts/
    │   ├── traits.ts                 # 32 wymiary + 6 cech safety
    │   └── evidence.ts               # typy lokalne i payload sieciowy
    ├── edge/
    │   ├── LocalLlmAdapter.ts        # kontrakt produkcyjnego llama.rn
    │   ├── MockLocalLlmAdapter.ts    # demo, niskie confidence
    │   ├── AgentSessionEngine.ts     # serializacja, budżet kontekstu, unload
    │   ├── EvidencePayloadBuilder.ts # maks. 10 rekordów, tekst -> SHA-256
    │   ├── EgressFirewall.ts         # whitelist kluczy i zakresów przed siecią
    │   └── DeviceSigner.ts           # key_id + miejsce na podpis urządzenia
    ├── lib/
    │   ├── id.ts                     # UUID/SHA-256 z expo-crypto
    │   └── supabase.ts               # anon key + AsyncStorage session
    ├── notifications/registerPush.ts
    ├── services/
    │   ├── evidenceApi.ts            # jedyny upload evidence
    │   └── matchesApi.ts             # Matches, powiadomienia, RPC odpowiedzi
    ├── state/
    │   ├── AuthContext.tsx
    │   └── AgentSessionContext.tsx   # czat, sesje, outbox, synchronizacja
    └── storage/LocalStore.ts         # szkielet; produkcyjnie podmienić na SQLCipher
```

Expo Router używa `src/app` jako katalogu tras. Klasyczny `App.tsx` z szablonu został usunięty, a `package.json.main` wskazuje `expo-router/entry`.

## D.2 Uruchomienie

```bash
cd apps/mobile
npm install
cp .env.example .env
# uzupełnij EXPO_PUBLIC_SUPABASE_URL i EXPO_PUBLIC_SUPABASE_ANON_KEY
npm run web        # albo: npm run android / npm run ios
npm run typecheck
```

Bez poprawnego `.env` ekran logowania oferuje **DEMO lokalne**:

- mock adapter prowadzi skryptowaną rozmowę z dwiema próbami z KROKU B;
- ekran Dopasowań pokazuje oznaczoną kartę DEMO 95%;
- żadne żądanie do Supabase/Abacus nie wychodzi.

Do produkcyjnej LLaMY i pushy na Androidzie potrzebny jest development build EAS, nie samo Expo Go.

## D.3 Przepływ czatu i budżetu urządzenia

```text
użytkownik pisze
  -> LocalChatMessage (tylko LocalStore)
  -> AgentSessionEngine.exclusive()
       - lazy load modelu
       - maks. 12 ostatnich wiadomości
       - maks. 6000 znaków kontekstu
       - odpowiedź
       - unload po 120 s bezczynności
  -> bąbelek asystenta

Zakończ sesję (jawny przycisk w nagłówku)
  -> ewaluator tylko dla niezweryfikowanego fragmentu i >= 3 tur usera
  -> EvidencePayloadBuilder: top <=10 evidence, source text -> sha256:...
  -> EgressFirewall.assertEvidencePayload()
  -> TelemetryOutbox (lokalna kolejka, maks. 20 paczek)

TelemetrySyncGate (null UI)
  -> AppState=active + NetInfo connected
  -> podpis urządzenia
  -> supabase.functions.invoke('ingest-evidence')
  -> ponów z backoffem maks. 8 razy
```

### Dlaczego 10 liczb z telefonu i 32 liczby w roju

KROK D ogranicza jedną sesję do **10 najpewniejszych trait-evidence**. To nie jest 10-wymiarowy profil. Serwer agreguje evidence z wielu dni i prób w hard-pointy, z których buduje pełny 32-wymiarowy `swarm_vector`. Dzięki temu pojedyncza rozmowa nie przepala baterii ewaluatorem całego profilu.

### Firewall PII

`EgressFirewall` nie filtruje tekstu „po fakcie”. Payload jest budowany z osobnych pól, a firewall przed zapisem do kolejki i przed HTTP wymaga:

- dokładnej whitelisty kluczy na każdym poziomie;
- `trait_key` wyłącznie ze słownika 38 cech;
- `score ∈ [-1,1]`, `confidence ∈ [0,1]`, severity `1..5`;
- `evidence_hash` zgodnego z `sha256:<64 hex>`, bez pola na cytat;
- maksymalnie 10 evidence i 8 flag;
- serialized payload ≤ 32 KiB;
- brak pola `memory_slot_updates`: pamięć rozmów zostaje na urządzeniu.

### Model lokalny: granica szkieletu

Domyślny `MockLocalLlmAdapter` służy wyłącznie do pracy nad UI. Jego heurystyki mają confidence `0.5`, więc nie utworzą hard-pointów. `LlamaRnNotLinkedAdapter` świadomie rzuca `LLAMA_RN_NOT_LINKED`. Aby przejść produkcyjnie:

1. dodać `llama.rn` i jego config plugin/dev build;
2. zaimplementować `load/chat/evaluate/unload` dokładnie pod `LocalLlmAdapter`;
3. wstrzyknąć prompt z `prompts/personal_agent_llama_system_prompt.txt` oraz aktywne próby z podpisanego bundla;
4. utrzymać rozdzielne wywołanie rozmowy (`temp 0.65`) i ewaluatora (`temp 0.10`) wg `prompts/personal_agent_config.json`;
5. pobierać model GGUF tylko po świadomym pobraniu przez użytkownika i weryfikować jego hash.

## D.4 Kanały sieciowe telefonu

| Kierunek | Endpoint / tabela | Autoryzacja | Dane |
|---|---|---|---|
| telefon → Supabase Auth | sign-in/sign-up | anon key + hasło | e-mail/hasło wyłącznie do Auth |
| telefon → `consent_log` | insert własnych zgód | JWT + RLS | scope, wersja regulaminu |
| telefon → `ingest-evidence` | Edge Function | JWT + nagłówek klucza urządzenia | liczby, kody, hashe |
| telefon ← `Matches` | select własnych par | JWT + RLS | wynik, komponenty, status; brak tożsamości drugiej strony |
| telefon ← `match_notifications` | select/update seen | JWT + RLS | ID matcha i status |
| telefon → `push_devices` | upsert tokenu | JWT + RLS | Expo Push Token, platforma |
| telefon → RPC | `fn_respond_to_match`, `fn_set_my_pause`, `fn_my_pos_status`, `fn_my_preference_summary` | JWT | kontrolowane przejścia statusów |
| telefon → Abacus | **brak** | — | — |

## D.5 Powiadomienie „Znalazłem kandydata”

Telefon nie może i nie powinien wystawiać publicznego webhooka. Zwrot Mastera trafia na trzy kanały:

1. **Expo Push Service → APNs/FCM** — `MatchRealtimeGate` po zalogowaniu rejestruje token przez `registerPushDevice`. Callback Supabase wysyła tytuł „Znalazłem kandydata” i body ze zgodnością.
2. **Supabase Realtime** — subskrypcja `postgres_changes` na `match_notifications`, filtr `recipient_user_id=eq.<uid>`.
3. **Polling awaryjny** — co 60 sekund i tylko przy `AppState=active`.

Kliknięcie pusha z `data.type = MATCH_PROPOSED` prowadzi do `/matches`. Ekran oznacza powiadomienia jako `seen`, pobiera match przez RLS i pozwala odpowiedzieć RPC `fn_respond_to_match`.

## D.6 Ekrany

- **Sign-in**: e-mail/hasło po konfiguracji albo DEMO.
- **Onboarding**: rozdzielenie „telefon vs rój”, opcjonalna zgoda szczególnej kategorii.
- **Agent**: zwyczajny messenger, awatar „A”, typing row, composer, przycisk zamknięcia sesji; FlatList jest memoizowana i ma ograniczone okno renderowania.
- **Dopasowania**: wynik 80–99%, paski kategorii, akceptacja etapu 1/odrzucenie; brak zdjęcia i tożsamości przed zgodą.
- **Prywatność**: liczba lokalnych wiadomości, oczekujące paczki, stan sync, ręczna synchronizacja, twarde usunięcie danych lokalnych.
- **Profil**: etap FSM, sam status PoS, podsumowanie preferencji bez bramek safety, pauza roju, wylogowanie.

## D.7 Produkcja: świadomie niedokończone w szkielecie

| Obszar | Stan szkieletu | Wymagane przed produkcją |
|---|---|---|
| sekretny magazyn czatu | AsyncStorage | SQLCipher + klucz w Keystore/Secure Enclave |
| LLaMA | mock + adapter `not linked` | llama.rn w EAS dev/prod build, pobieranie i hash modelu |
| podpis paczki | key_id w SecureStore; dev może użyć `dev-unsigned` | Ed25519 + weryfikator w `ingest-evidence` + atestacja Play Integrity/App Attest aktywująca klucz |
| push | rejestracja tokenu i kanał Android | EAS projectId, certyfikaty APNs/FCM, test na fizycznym urządzeniu |
| PWA/web | responsywny export web | osobna decyzja o Service Workerze i Web Push; natywny push nie działa na webie |
| głos | brak przycisku nagrywania w szkielecie | STT wyłącznie on-device, kasowanie audio po transkrypcji, brak inferencji emocji |
| sesje w tle | jawne zamknięcie przyciskiem | polityka inactivity/background zgodna z OS i testy baterii/termiki |

## D.8 Testy wykonane

- `npm run typecheck` — OK.
- `npx expo export --platform web` — OK, Expo Router wykrył `src/app`, zbudowano trasy czatu, dopasowań, onboardingu, prywatności i profilu.
- `npx expo-doctor` — 18/20 kontroli przeszło w sandboxie; dwie kontrole wymagały sieci do Expo API/React Native Directory, która jest zablokowana.
- `npx expo lint` — nie utworzył konfiguracji z powodu tej samej blokady sieciowej; uruchom ponownie po podłączeniu właściwego środowiska.
