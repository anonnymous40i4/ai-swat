# ai-swat — AI Swarm-Match

Multi-agentowy system dopasowań relacyjnych bez swipe'owania: lokalny Osobisty Agent (LLaMA on-device)
poznaje zamiary, wartości i bezpieczeństwo użytkownika w naturalnej rozmowie, a do roju w Supabase
trafia wyłącznie pseudonimowy, 32-wymiarowy wektor + status Proof of Safety. Master Agent („Wielki Swat”)
proponuje dopasowanie dopiero przy zgodności wartości na poziomie 80–99/100.

## Dokumenty (Blueprint v0.1)

| Plik | Zawartość |
|---|---|
| [`docs/00_BLUEPRINT_A_B.md`](docs/00_BLUEPRINT_A_B.md) | **KROK A:** schemat bazy Supabase, wektor 32-wymiarowy, PoS, matematyka Mastera, RLS, retencja. **KROK B:** rama Osobistego Agenta, FSM D0–D5, dozwolone/zakazane, 2 pułapki SJT z rubrykami |
| [`supabase/migrations/202610180001_ai_swarm_match_init.sql`](supabase/migrations/202610180001_ai_swarm_match_init.sql) | wykonywalna migracja: 20 tabel, `pgvector` (HNSW), funkcje candidata, polityki RLS, seedy słownika cech i katalogu prób |
| [`docs/01_ABACUS_ORCHESTRATION_KROK_C.md`](docs/01_ABACUS_ORCHESTRATION_KROK_C.md) | **KROK C:** drzewo agentów w Abacus, izolacja węzłów, outbox→`executeAgent`→cosine→callback, HMAC/retry |
| [`orchestration/abacus/`](orchestration/abacus/) | Python: węzły Master Swata i budowa `WorkflowGraph` przez SDK Abacus |
| [`supabase/functions/`](supabase/functions/) | Edge Functions: ingest evidence, bundle kandydatów, dispatcher outboxa, callback Mastera + Expo Push |
| [`docs/02_EXPO_MOBILE_KROK_D.md`](docs/02_EXPO_MOBILE_KROK_D.md) | **KROK D:** architektura aplikacji Expo, edge firewall, limity inferencji, kanały powiadomień |
| [`apps/mobile/`](apps/mobile/) | działający szkielet Expo SDK 58 / Expo Router: messenger, dopasowania, prywatność, DEMO bez backendu |
| [`prompts/personal_agent_llama_system_prompt.txt`](prompts/personal_agent_llama_system_prompt.txt) | kompletny System Prompt Osobistego Agenta (LLaMA 3.x, lokalnie) — gotowy do wklejenia |
| [`prompts/personal_agent_config.json`](prompts/personal_agent_config.json) | parametry generacji (rozmowa vs ewaluator), składnia czatu, protokół kanału evidence |
| [`prompts/probe_catalog_v1.json`](prompts/probe_catalog_v1.json) | ustrukturyzowany katalog prób (2 pełne wzorce + lista brakujących) |
| [`contracts/trait_evidence.schema.json`](contracts/trait_evidence.schema.json) | kontrakt JSON jedynych danych wysyłanych z urządzenia do roju |

## Zasady niepodlegające negocjacjom

1. **99/1:** surowe rozmowy i audio nie opuszczają telefonu.
2. Baza nie zawiera nazwisk, zdjęć, wagi, ubrań, zarobków, GPS ani transkryptów.
3. Proof of Safety jest bramką z przeglądem człowieka — Agent sam nikogo ostatecznie nie banuje.
4. Brak diagnoz i etykiet klinicznych; wyniki to hipotezy behawioralne do walidacji pilotażowej.
5. Uczciwie deklarowany zamiar (też „tylko niezobowiązująco”) nigdy nie jest karany; karany jest fałsz co do zamiarów.

## Uruchomienie schematu (gdy będzie projekt Supabase)

```bash
supabase db push   # stosuje migrację z supabase/migrations/
```
