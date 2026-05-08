// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

export type ProviderPresetId = 'deepseek' | 'zai' | 'custom';

export interface ProviderPreset {
  readonly id: ProviderPresetId;
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly secretKey: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    secretKey: 'deepseek',
  },
  {
    id: 'zai',
    label: 'ZAI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.1',
    secretKey: 'zai',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    secretKey: 'custom',
  },
];

export function getProviderPreset(id: ProviderPresetId): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)!;
}
