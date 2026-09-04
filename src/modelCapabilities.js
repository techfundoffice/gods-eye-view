/**
 * The single server-side source of truth for model input capabilities.
 * Unknown models are deliberately treated as text-only.
 */

const IMAGE_MODEL = /(?:gemini|gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|grok-4|llava|qwen[^/]*(?:vl|vision)|pixtral|vision)/i;
const TEXT_ONLY_MODEL = /(?:openrouter\/free|deepseek|llama-(?:2|3)(?![^/]*(?:vision))|mixtral|mistral-(?:7b|small)|command-r)/i;

export function resolveModelCapabilities(model, explicitProvider = '') {
  const options = model && typeof model === 'object' ? model : null;
  const id = String(options?.model || model || '').trim().toLowerCase();
  const acceptsImages = Boolean(id) && !TEXT_ONLY_MODEL.test(id) && IMAGE_MODEL.test(id);
  const isGemini = /gemini/i.test(id);
  const acceptsAudio = isGemini || /(?:gpt-4o-audio|gpt-audio|claude-3\.5-sonnet)/i.test(id);
  const acceptsVideo = isGemini || /(?:grok-4|claude-4)/i.test(id);
  const provider = String(
    options?.provider
    || explicitProvider
    || (id.includes('/') ? id.split('/')[0] : 'openrouter'),
  ).trim().toLowerCase();
  return Object.freeze({
    model: id,
    provider,
    modelVendor: id.includes('/') ? id.split('/')[0] : '',
    text: true,
    images: acceptsImages,
    audio: acceptsAudio,
    video: acceptsVideo,
    acceptsText: true,
    acceptsImages,
    acceptsAudio,
    acceptsVideo,
    // OpenRouter accepts the OpenAI tools envelope for configured routes,
    // including openrouter/free; a particular routed model may still decline
    // to call one, which is model output rather than transport capability.
    toolCalling: Boolean(id),
    // These are request-side limits, not a claim that the provider will fetch
    // remote media. The assembler only transports inline, bounded media.
    limits: Object.freeze({
      contextChars: 6000,
      imageBytes: 1_500_000,
      audioBytes: 1_000_000,
      videoFrames: 4,
      videoFrameBytes: 1_000_000,
      maxContextChars: 6000,
      maxImageBytes: 1_500_000,
      maxAudioBytes: 1_000_000,
      maxVideoFrames: 4,
    }),
    contentFormat: acceptsImages || acceptsAudio || acceptsVideo ? 'openai-multimodal' : 'text',
  });
}

export const modelCapabilities = resolveModelCapabilities;