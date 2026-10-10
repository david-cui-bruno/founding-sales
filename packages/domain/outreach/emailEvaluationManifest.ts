/** Immutable manifest of the reviewed frozen diagnostic corpus.
 * A matching documentary report is not authentication of an external tool or provider.
 * Refresh this manifest deliberately alongside reviewed corpus/prompt changes. */
export const EMAIL_EVALUATION_MANIFEST = {
  "version": 1,
  "evidenceAsOf": "2026-10-08T00:55:00.000Z",
  "promptSourceSha256": "3d09972ea2fac74568cd7d5bc88b25745541fdd04f27762688eed7820d24536c",
  "corpus": [
    {
      "path": "apps/worker/test/support/emailEvaluationSources.json",
      "sha256": "30e3e50a2eebe6a594d23a0d720807efcd9e604df325e6d3ed7b9ebebda5c153"
    },
    {
      "path": "apps/worker/test/support/emailEvaluationChallenges.json",
      "sha256": "a60e0e07799f3d1d51bfc8d360554814e66f945d316d9b171fe8b4c6ddf7e8c5"
    }
  ],
  "cases": [
    {
      "id": "nhs-identity",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "1eb99981-2b7c-413c-9ab8-40c9529228ad",
        "runId": "dd9d0d7d-1114-4390-a549-70b6b11eff50",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "The selected identity says NHS, not the candidate NHS Properties; residential and office association remain unsupported."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "f2fcbacd-8491-4b59-8937-f5ea5f70a912",
          "url": "https://www.nhsproperties.com/about-us",
          "retrievedAt": "2026-10-07T16:08:25.172Z",
          "contentHash": "4b21f5f06310487663d470ee1043c7c13cc9c661cfc70dc2ea3a26e3b3496f71",
          "relevantTextHash": "6b1991f23cce481b9b2794a2c9c55559903c5d668b6fde19212b7255d34cd406",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b7",
            "b7",
            "b14",
            "b16"
          ]
        },
        {
          "observationId": "ec2ffb4a-08c1-419a-9027-6b053c747b66",
          "url": "https://www.nhsproperties.com/contact-us",
          "retrievedAt": "2026-10-07T16:08:25.211Z",
          "contentHash": "1de6acaf957eb3d0639c4410ed5a52f9300ee45eeb14176324ea44da00d9371c",
          "relevantTextHash": "9bf34bb08d57bad2809b9758c81fb0cd18ab0fa7169ec97bebb0861e31ed6a99",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "40eda4f8-5d5f-411a-9cab-5825d897a900",
          "url": "https://www.nhsproperties.com/tenant",
          "retrievedAt": "2026-10-07T16:08:25.224Z",
          "contentHash": "bbf52da45acc810b3ca6ff4556970e363e4f152928aefe9d16ba6339062780af",
          "relevantTextHash": "03c04e0ea99a7a9b2c185c0d2f8d993fb818a9e7ee706a1ae3622ce533e2dd69",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b9",
            "b10"
          ]
        },
        {
          "observationId": "2f50d324-1370-496a-84dc-54cbb52cfc89",
          "url": "https://www.nhsproperties.com/tenant-portal",
          "retrievedAt": "2026-10-07T16:08:25.236Z",
          "contentHash": "94b70f0e7f4877f364b0a394d7ba5f7b5732b4aa1dfc2ab073ea6d65310b91ca",
          "relevantTextHash": "42d9cee2810c7a18d97dbafcd1c972323d06f8e3367abda47040b98839d80ae8",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        }
      ]
    },
    {
      "id": "nexus-title",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "9d27b836-f636-4d87-b6f6-5bc5f9abdcd6",
        "runId": "6679d442-ff89-4dab-b827-9ffc7057f876",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "The search-title candidate is not a resolved firm identity; there is no selected business email. Staff are context."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "cf85bb59-da98-49e7-b5da-f2a6236fbb3e",
          "url": "https://www.nexri.com/",
          "retrievedAt": "2026-10-07T16:07:26.316Z",
          "contentHash": "8e9922c292d6d57d65bd2d9bec45d8b7d8149e8d6958c17b695c6b55a0b33601",
          "relevantTextHash": "a4c66c3282feb48b7375fc8c09796a511c11a069a1f5c1ad66f90f21209f1d8e",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b42",
            "b42",
            "b42",
            "b56",
            "b3"
          ]
        },
        {
          "observationId": "277f9e77-17d2-420b-9a29-ca75c9e3af0c",
          "url": "https://www.nexri.com/contact-nexus-professional-property-management",
          "retrievedAt": "2026-10-07T16:07:26.608Z",
          "contentHash": "6b69fd4351d139cb4e2d37b8ba21e186710e8a853ceb8c026cb8cae7965d64e3",
          "relevantTextHash": "4285a599e5e20c55be38746c337416a6bdb31c6de20769caeef930f4123541d1",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "d9d80035-afff-4a39-ba4b-64594cdf2d3b",
          "url": "https://www.nexri.com/aboutus",
          "retrievedAt": "2026-10-07T16:07:26.860Z",
          "contentHash": "40f51dd0f4a534f56e63566e763b718377964c3ec16acd6a63148dc3c0e042f2",
          "relevantTextHash": "bdec5e02b1b6282ff4ea78420d4cad4c10f93031287be1548f5b849770c24f57",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "0f5a8b76-bdfe-42a7-9713-97c754fa632b",
          "url": "https://www.nexri.com/services",
          "retrievedAt": "2026-10-07T16:07:27.059Z",
          "contentHash": "9509f80ea19beef292cd6154c0c57e4bf74486efa4fd074541c29defc5184456",
          "relevantTextHash": "c38086cbfa7320429804b5616f1dd6cf3465c1c1ac78e212f679a23a1f03be16",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b24"
          ]
        }
      ]
    },
    {
      "id": "key-fit",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "b91336ef-9858-4104-af3e-435f7f94885a",
        "runId": "d88faaaa-23ad-4bce-83ed-80c73dcd1f6f",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "Residential tenant paragraph, matching company heading and compact Fort Worth office card support fit and published office email; no pain claim. Production Key already enrolled; this is isolated replay."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "b46e4a83-5b84-4c0d-8790-6a6b1f608d9e",
          "url": "https://www.keyretx.com/contact",
          "retrievedAt": "2026-10-07T16:08:25.738Z",
          "contentHash": "eb976bb6889ed2a29b476bcd9cd3bb610acf437193bb6ff608f1189fa29103d5",
          "relevantTextHash": "25f942c6f9b495992aaf764313d3a0e3a6c63ff1bdb6e1b536193bc70c20dcf5",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b35",
            "b37",
            "b38",
            "b39"
          ]
        },
        {
          "observationId": "22c2588c-4e7e-4255-945b-0c751d0d33e1",
          "url": "https://www.keyretx.com/owner-faq",
          "retrievedAt": "2026-10-07T16:08:26.269Z",
          "contentHash": "d8c77262eae004b4b799f68258d94647c60378287f259f6ba7e0dae63abb9031",
          "relevantTextHash": "3a2931f9b577165335b0f48af9368e6b0ca37cb9b2f6998faa5a608a870c9486",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "bc890a1f-3112-4e95-acf4-8d1f0eccbb42",
          "url": "https://www.keyretx.com/tenants",
          "retrievedAt": "2026-10-07T16:08:26.546Z",
          "contentHash": "282f4e9569308c2810220192a95287a26983a83bcdf0153589ed2fdb05f48f5c",
          "relevantTextHash": "976e971d520866d8ce619e04c5081843c1f38f4e12f5e4eda27bc140940aa6c4",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b38"
          ]
        },
        {
          "observationId": "21db5178-f1ab-44b4-94e7-a54a82ef8246",
          "url": "https://www.keyretx.com/tenant-faq",
          "retrievedAt": "2026-10-07T16:08:26.921Z",
          "contentHash": "f14c146652fd121a2fb2978129fc6d696496e010515f1b4264399018fcd67458",
          "relevantTextHash": "480bba398680fd844366fa8b63bc7c623d66bc95bda8c62a807ce516fa1bec65",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        }
      ]
    },
    {
      "id": "rentprov-team-context",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "dd73d48c-ccb6-4cb9-9cf6-daa63d6e2d6b",
        "runId": "92fe1b46-9e8f-4870-8a25-20164136ac9b",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "First-party descriptive residential-management paragraph and Providence office card support fit. Head of Maintenance is context, not a rejection or pain claim."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "cb67b537-31fd-4810-8f74-d983723914b5",
          "url": "https://www.rentprovrealty.com/",
          "retrievedAt": "2026-10-07T16:07:05.586Z",
          "contentHash": "d4dc7ff57565be56c5a9c472f58999630c1291a7d6d38e54894d29b03a8543b2",
          "relevantTextHash": "a9d9006fc5087910f4f2bf7e2208978a8df123c21898a9289cd485ceb94b8ec6",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b29",
            "b29",
            "b40"
          ]
        },
        {
          "observationId": "82d51be0-074f-47c5-a7c4-edf85091dd79",
          "url": "https://www.rentprovrealty.com/contact/",
          "retrievedAt": "2026-10-07T16:07:06.781Z",
          "contentHash": "0b1c52cc2769983dba60e6d2d18bf8d42c6298b22f81d5c8fab9b501887fbf99",
          "relevantTextHash": "8ac5a07d049553ef31a5cc1ea5004fc4aa283882e654b0a68d016f46be125acd",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b4",
            "b5"
          ]
        },
        {
          "observationId": "96104f48-5d0d-4394-a944-6e952b602f4f",
          "url": "https://www.rentprovrealty.com/our-team/",
          "retrievedAt": "2026-10-07T16:07:07.713Z",
          "contentHash": "83019468a2318c1b253f0a5740a4b0d25d4b1719ddac335185a6b3a50216fffa",
          "relevantTextHash": "038401b0ebc6d24d46fadcb166361bf3792edd77efca1ef50a14f903be9bf056",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b55"
          ]
        },
        {
          "observationId": "9f890bf4-c02d-48db-8ff5-31f58d0fbda8",
          "url": "https://www.rentprovrealty.com/join-our-team/",
          "retrievedAt": "2026-10-07T16:07:09.364Z",
          "contentHash": "62b5444a4a17e6dd32728568f8fc99349990b478f2016b9a8846b0fbd0ca001b",
          "relevantTextHash": "b94aca363886d8c13a932a9cfd00a1217b64ac9fd1000e9da668e5869bb147c7",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        }
      ]
    },
    {
      "id": "lyon-incomplete-title",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "e71b8514-a1e3-4a88-bc8f-f6ddc713169f",
        "runId": "297d33f9-672f-4e35-a5c3-1d68154b71bb",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "Search-title identity mismatch and truncated supporting residential page; selected business_email is a street address, not an email."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "2687b77c-0944-4868-ae62-0f3e3c5a458a",
          "url": "https://lyonpropertygroup.com/areas-we-serve/providence-ri/",
          "retrievedAt": "2026-10-07T16:07:26.398Z",
          "contentHash": "736b6b5aa11a7b790c7d24b76d6f0bcb2b71ddc4013135879e531ea5358ddc1f",
          "relevantTextHash": "9a854b485fd47b6c9a8eb2bf0e788a47a387d1fe869b87326e88432914b53f43",
          "truncated": true,
          "firstParty": true,
          "selectedBlockIds": [
            "b4",
            "b15",
            "b61",
            "b98",
            "b99"
          ]
        },
        {
          "observationId": "3eceae83-3795-4392-913a-89bdbb9f7613",
          "url": "https://lyonpropertygroup.com/contact/",
          "retrievedAt": "2026-10-07T16:07:26.836Z",
          "contentHash": "3246827436681d1fe061dce41cc62a80b937e8607b3ace5b5476443c4e59092b",
          "relevantTextHash": "e9bbc0762895730733a96d711b3c756ee576f059f987d9b8c5451324d16f679c",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "c9b6f12c-5fbf-433b-b457-eeb6904a37e7",
          "url": "https://lyonpropertygroup.com/resident-portal/",
          "retrievedAt": "2026-10-07T16:07:27.260Z",
          "contentHash": "6ea73d3b739b9b2e7b4dcac357f120b04402aceb663ea1b43fb30b9090aa4475",
          "relevantTextHash": "c3f65d9b3558712f7a724cc9d85230b8ae11dd292f6e183a92eae45167b6695b",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "10e56087-2002-4f89-8d3d-f0bb13b9c7bc",
          "url": "https://lyonpropertygroup.com/services/multi-family-management/",
          "retrievedAt": "2026-10-07T16:07:27.645Z",
          "contentHash": "e08b705765f3a3894cbca9db651f29b2d89b3ef288affa6da6907067677cc5a5",
          "relevantTextHash": "5b86a4479ce54c03df0c842c1bbd5ef8da7cf7d55c1110079a3da02260580dab",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        }
      ]
    },
    {
      "id": "zanno-incomplete",
      "provenance": {
        "kind": "recorded_first_party_extraction",
        "candidateId": "e8e64db9-e8ce-4c2f-8c99-40c60ba2a577",
        "runId": "14326add-1ef4-4bf4-962e-873541df9709",
        "promptVersion": "qualification-growth-v6",
        "reviewNote": "Current v6 refresh still lacks the candidate search-title identity, explicit residential-management and city/state evidence. Published email uses zannoco.com, not the source zannopm.com host. Portal/vendor support is context, not pain. Must defer.",
        "originalRunId": "d1b975db-86da-4fde-b81d-0bce6a86c8ea",
        "originalPromptVersion": "qualification-email-v2",
        "originalEvidenceSha256": "1fd8e0a767ec168e76bae9dfce789e8a16900967cc6446b344360a3e9adb47a9",
        "refreshScope": "disposable_database_current_bounded_qualification",
        "modelName": "claude-haiku-4-5",
        "recordedCostCents": 1,
        "evaluationCeilingCents": 5
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "118f9962-5522-4942-bc91-abb79085be0c",
          "url": "https://www.zannopm.com/",
          "retrievedAt": "2026-10-08T00:54:18.366Z",
          "contentHash": "b8d6de4707a459b53cfa532112323436870454ce4fff4ef361a6e6b64a691740",
          "relevantTextHash": "84785641dd1d85b958e962b4e599281b04952be3e25626a9ae6f2681b1b5637d",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b6",
            "b8",
            "b8"
          ]
        },
        {
          "observationId": "4ea43b7c-6f17-427e-bc5b-116c5b452302",
          "url": "https://www.zannopm.com/contact",
          "retrievedAt": "2026-10-08T00:54:18.754Z",
          "contentHash": "ede76ecdc930da06fa2146789daac15cd17540b56f4abaae220dfc5344d9fb7e",
          "relevantTextHash": "e8b3ed9460c439a63d3ab39821be9492f9d4b053ae5f2861e97ece6844208319",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b9",
            "b32"
          ]
        },
        {
          "observationId": "bb74477e-8d9c-4b40-8ae4-8a4723b75fcf",
          "url": "https://www.zannopm.com/tenant-screening",
          "retrievedAt": "2026-10-08T00:54:19.693Z",
          "contentHash": "18a6ee029db3c3667492f318414e7dc48cc8ee1555fa4c98357debbeb6912ceb",
          "relevantTextHash": "248e40268a071d8bee016f745f5b35c6ca2757b70c4a1ed0c4a5bdbed0d938b6",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": []
        },
        {
          "observationId": "9c831be8-7908-4e4b-ad63-2edf36cad13c",
          "url": "https://www.zannopm.com/maintenance-services",
          "retrievedAt": "2026-10-08T00:54:20.095Z",
          "contentHash": "f1b99f4783204dc63281f22a5b34e71ce23ad7e22e3ebc7feb598f18f913d9fe",
          "relevantTextHash": "abe90aac027f70413ebd3f45ae38c753cd9ae9bcad37f8406cb4cee26b80ef80",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "b11"
          ]
        }
      ]
    },
    {
      "id": "fit-without-pain",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Supported TX residential fit and office email; phone and pain optional."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "7d0143cb-4f3f-50b0-a61b-abd9e54779b9",
          "url": "https://fit-without-pain.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "9281e44ab5a9b3aa9d2c518b41c6fbc51b99e31400a8023174fcad35a5021ad2",
          "relevantTextHash": "9281e44ab5a9b3aa9d2c518b41c6fbc51b99e31400a8023174fcad35a5021ad2",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "ri-fit",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Providence RI target, residential fit and office email."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "1702c331-2719-565e-848d-b57f9ff8ea2c",
          "url": "https://ri-fit.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "d7264c5c8bcb5e3666b8f517d444b9edcd750a3b50334815029f1a2c61d63011",
          "relevantTextHash": "d7264c5c8bcb5e3666b8f517d444b9edcd750a3b50334815029f1a2c61d63011",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "ma-fit",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Boston MA target, residential fit and office email."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "61c7dc01-e5cb-597f-a16e-abc5f7e4ea53",
          "url": "https://ma-fit.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "3ebd170710aae3b3257db1343cf8557da54140e121ffe709c2404e0973828f61",
          "relevantTextHash": "3ebd170710aae3b3257db1343cf8557da54140e121ffe709c2404e0973828f61",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "software-team",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "AppFolio and maintenance staff are context, never unmet need or automatic exclusion."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "bb532335-0b50-51e1-9edf-b9c435423ab7",
          "url": "https://software-team.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "3279438bc544e9e21f61a8018207750c75a4d059119ffc1aec0c32e7460c531e",
          "relevantTextHash": "3279438bc544e9e21f61a8018207750c75a4d059119ffc1aec0c32e7460c531e",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "current-help",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Own current dated explicit help request outranks fit."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "help_request",
      "evidence": [
        {
          "observationId": "674caf7d-1b7d-5e11-9a98-43eeb0dfedbd",
          "url": "https://current-help.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "f7c421fdf469db347ef499db498bad51bd40d294d689c4e3297edba14a98b0fa",
          "relevantTextHash": "f7c421fdf469db347ef499db498bad51bd40d294d689c4e3297edba14a98b0fa",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "unknown-help",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Undated request must not gain pain priority."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "a1421d8d-f47e-588f-8385-b939476cf5bd",
          "url": "https://unknown-help.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "7677e9dbb175bd502fa520508d47969992ea7e454fd42d1d567220667243e524",
          "relevantTextHash": "7677e9dbb175bd502fa520508d47969992ea7e454fd42d1d567220667243e524",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "expired-help",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Expired help keeps otherwise supported fit only."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "e897e1ed-9a1c-5fa3-8499-be040c1f2478",
          "url": "https://expired-help.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "502b674424ef3e40dfa3de320f17c101f20a92a988d667589490635e6bd42424",
          "relevantTextHash": "502b674424ef3e40dfa3de320f17c101f20a92a988d667589490635e6bd42424",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "expired-growth",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Expired growth cannot gain investigation priority."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "a3ba1828-ce3c-5f7c-8904-2318e033de7a",
          "url": "https://expired-growth.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "b64bda2319ce61ced772cd0a6c305b36d212f2c8e1a59d5788937734de63ccb1",
          "relevantTextHash": "b64bda2319ce61ced772cd0a6c305b36d212f2c8e1a59d5788937734de63ccb1",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "unknown-job",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Undated hiring cannot gain investigation priority."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "de92ab94-710e-5913-88e4-642f33323363",
          "url": "https://unknown-job.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "15db0076278e1d7b440c8abd392a9e2b79dd1dfafb72e439cb1688b7dce0d2d2",
          "relevantTextHash": "15db0076278e1d7b440c8abd392a9e2b79dd1dfafb72e439cb1688b7dce0d2d2",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "contrary-need",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Explicit denial of maintenance need blocks supported fit."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "da961102-d24e-54eb-b700-6e3d24954062",
          "url": "https://contrary-need.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "d45447dcdf94c4c4d2df91c26113549650e32f767c66e3654baf032e6753b380",
          "relevantTextHash": "d45447dcdf94c4c4d2df91c26113549650e32f767c66e3654baf032e6753b380",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email",
            "extra"
          ]
        }
      ]
    },
    {
      "id": "stale-source",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Eight-day-old source is not fresh."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "b6a756dd-b177-51aa-8488-5d4ee5d78ce3",
          "url": "https://stale-source.example.test/",
          "retrievedAt": "2026-09-29T12:00:00.000Z",
          "contentHash": "b7dc893873f31832bdfe4621ada8f8ac75be7f61827f50a2fef0405e91621faa",
          "relevantTextHash": "b7dc893873f31832bdfe4621ada8f8ac75be7f61827f50a2fef0405e91621faa",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "future-source",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Future retrieval cannot establish fresh evidence."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": false,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "9a547dcf-23df-5c70-b9f3-462e31c75a15",
          "url": "https://future-source.example.test/",
          "retrievedAt": "2026-10-09T12:00:00.000Z",
          "contentHash": "cedd9b8c1961bcd485ef7b743bdbc9a58f63a5a7a5c27248e974a2bfa8edcd27",
          "relevantTextHash": "cedd9b8c1961bcd485ef7b743bdbc9a58f63a5a7a5c27248e974a2bfa8edcd27",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "truncated-source",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Truncated first-party page cannot establish complete evidence."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "fef4b5a3-2e8b-5192-9ef7-7ae5a88ce007",
          "url": "https://truncated-source.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "151314f202652b3e2425249c0848aa19588778a50d20ff7725b95036076f5b81",
          "relevantTextHash": "151314f202652b3e2425249c0848aa19588778a50d20ff7725b95036076f5b81",
          "truncated": true,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "third-party",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Third-party text does not establish first-party association."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "4a92a378-439d-5974-a3c8-f489218d0ca1",
          "url": "https://third-party.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "df0d2127517ac71d5b52a22c062f4fb0fa1b84480ed3ac1abfbe1ed19faf040f",
          "relevantTextHash": "df0d2127517ac71d5b52a22c062f4fb0fa1b84480ed3ac1abfbe1ed19faf040f",
          "truncated": false,
          "firstParty": false,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "mismatched-host",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Even a firstParty flag does not authorize a mismatched website host."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "efbf5a99-bef0-5c48-828f-e66ef2a38409",
          "url": "https://unrelated.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "73a4ed0fccb72914754c6207fa967c73ef5dbeeed9c85fa8417ef8c96d679ddf",
          "relevantTextHash": "73a4ed0fccb72914754c6207fa967c73ef5dbeeed9c85fa8417ef8c96d679ddf",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "wrong-identity",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Another company paragraph cannot resolve this candidate."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "4d2d4d80-f65e-5e4a-b889-d309c4cf7ef5",
          "url": "https://wrong-identity.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "3d87d56cde9f7692b52e2fdcccbcee68f7bcb65136e1af51d5e8099c9922395d",
          "relevantTextHash": "3d87d56cde9f7692b52e2fdcccbcee68f7bcb65136e1af51d5e8099c9922395d",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "commercial-only",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Commercial management is outside residential fit."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "66645a5f-ac85-51f1-99aa-ccbbcd8bf2ea",
          "url": "https://commercial-only.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "0b9222e40e5a9a2e70a5a57a1169283a15a2398ed8fb03c6fb4812bd1a01afbb",
          "relevantTextHash": "0b9222e40e5a9a2e70a5a57a1169283a15a2398ed8fb03c6fb4812bd1a01afbb",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "res",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "navigation-only",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Property Management navigation label does not establish residential management."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "04029f84-6725-5412-9a92-522cea53f9a3",
          "url": "https://navigation-only.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "69e419a7b51c09cda19dcb47929c342ef1e09a61eed235216999f28f76ffeada",
          "relevantTextHash": "69e419a7b51c09cda19dcb47929c342ef1e09a61eed235216999f28f76ffeada",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "res",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "wrong-geography",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "A CA office does not support a TX candidate."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "af136737-7285-555a-b7f0-314de5b63eb5",
          "url": "https://wrong-geography.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "3ba3e7fa0d1ea40c31614323775e83b9c44e1ac91d9e263aaf9cad4121f07d3f",
          "relevantTextHash": "3ba3e7fa0d1ea40c31614323775e83b9c44e1ac91d9e263aaf9cad4121f07d3f",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "unsupported-ri-city",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "RI targeting is restricted to settled cities."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "b0efc581-4cf2-5e45-bb65-470ef35b7ad9",
          "url": "https://unsupported-ri-city.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "d2b87b529746461a49648e28aae5325a11687f7ab4417768c5069b9eefa94e15",
          "relevantTextHash": "d2b87b529746461a49648e28aae5325a11687f7ab4417768c5069b9eefa94e15",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "consumer-email",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "A published consumer-domain address remains excluded."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "c2863528-850e-5656-a701-0828d42f8dde",
          "url": "https://consumer-email.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "ffecd31f5ddb68679a93ad7efa41e8180cec117a6b32daffe5674592dc4c1f80",
          "relevantTextHash": "ffecd31f5ddb68679a93ad7efa41e8180cec117a6b32daffe5674592dc4c1f80",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "vendor-contact",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Vendor wording cannot establish firm association."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "24e2e5ab-63cd-5882-81ee-3be2f74c2614",
          "url": "https://vendor-contact.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "5b763f838cd8b3cbefcb96ea6b1ddfeb6606daafcb74f9bb4986c460a991513d",
          "relevantTextHash": "5b763f838cd8b3cbefcb96ea6b1ddfeb6606daafcb74f9bb4986c460a991513d",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "guessed-email",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Suggested email patterns are not a published route."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "7a9ac896-b1f7-543e-98ed-51ca41592898",
          "url": "https://guessed-email.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "568f9b3fdd778459fde50d95f0180a105e16e3dbd0c673753a0bb0e357dba689",
          "relevantTextHash": "568f9b3fdd778459fde50d95f0180a105e16e3dbd0c673753a0bb0e357dba689",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "ambiguous-email",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Two office addresses in one selected block do not establish exactly one route."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "f707afe4-1bd5-5b3c-9961-09ee1459217a",
          "url": "https://ambiguous-email.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "cf68f2775643b428e31e2573247aa6ce887672a33a20b4f152ac9a1b020a67e5",
          "relevantTextHash": "cf68f2775643b428e31e2573247aa6ce887672a33a20b4f152ac9a1b020a67e5",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "unnamed-person",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "A non-role address without an explicit named contact does not establish person association."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "cab79a9e-7372-53f7-89ce-720c49e400df",
          "url": "https://unnamed-person.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "ff4183d4bb4385105dc6ac191afc4b9fe7b0c58a1f4d4dfdb381744b60828bd9",
          "relevantTextHash": "ff4183d4bb4385105dc6ac191afc4b9fe7b0c58a1f4d4dfdb381744b60828bd9",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "named-contact",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Source explicitly names a person and the address; no inferred name."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "820af8b2-841f-5fc4-8e9b-19ed31a084ec",
          "url": "https://named-contact.example.test/",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "180272ae0dbeef0c1621f42b962af319f99164a2f999b061ad29508ff18d43c0",
          "relevantTextHash": "180272ae0dbeef0c1621f42b962af319f99164a2f999b061ad29508ff18d43c0",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "email"
          ]
        }
      ]
    },
    {
      "id": "suite-office-card",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Synthetic boundary for the recorded eight-block office layout; not a new real lead."
      },
      "expectedAdmission": true,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "404dd8db-9375-481a-a36f-9ceda7563c6b",
          "url": "https://suite-office-card.example.test/contact",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "978ca3600b09ffd6803a913ffd5b71f0f8b6e2fe9c66305ff331e5e98d2a5f7e",
          "relevantTextHash": "978ca3600b09ffd6803a913ffd5b71f0f8b6e2fe9c66305ff331e5e98d2a5f7e",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "b7"
          ]
        }
      ]
    },
    {
      "id": "suite-office-other-city",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Synthetic boundary for the recorded eight-block office layout; not a new real lead."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "f300a95d-cd81-435a-9d53-afae7c8b49f4",
          "url": "https://suite-office-other-city.example.test/contact",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "9a1426e3503949da93b0db35c287b4471e1a7dbbde6d01b068def7ec2615770b",
          "relevantTextHash": "9a1426e3503949da93b0db35c287b4471e1a7dbbde6d01b068def7ec2615770b",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "b7"
          ]
        }
      ]
    },
    {
      "id": "suite-office-investor-label",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Synthetic boundary for the recorded eight-block office layout; not a new real lead."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "74dadd69-2f7d-4a39-bb74-24d6feecd40f",
          "url": "https://suite-office-investor-label.example.test/contact",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "3d264c6784e96e4bfb7b42ec08724d3ebcad889d9f425adf8e88fc5a37f82e2a",
          "relevantTextHash": "3d264c6784e96e4bfb7b42ec08724d3ebcad889d9f425adf8e88fc5a37f82e2a",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "b7"
          ]
        }
      ]
    },
    {
      "id": "suite-office-second-email",
      "provenance": {
        "kind": "synthetic_adversarial_or_boundary",
        "reviewNote": "Synthetic boundary for the recorded eight-block office layout; not a new real lead."
      },
      "expectedAdmission": false,
      "expectedEvidenceAccepted": true,
      "expectedRank": "fit_only",
      "evidence": [
        {
          "observationId": "a1554a27-56d6-4bde-a035-98515ae872b2",
          "url": "https://suite-office-second-email.example.test/contact",
          "retrievedAt": "2026-10-07T12:00:00.000Z",
          "contentHash": "753652d050663ef57a036cb50adf92bcaff6c6f03c946e465f1b16a0afd1885d",
          "relevantTextHash": "753652d050663ef57a036cb50adf92bcaff6c6f03c946e465f1b16a0afd1885d",
          "truncated": false,
          "firstParty": true,
          "selectedBlockIds": [
            "firm",
            "firm",
            "firm",
            "b7"
          ]
        }
      ]
    }
  ]
};
