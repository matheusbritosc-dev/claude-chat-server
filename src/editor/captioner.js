'use strict';

/**
 * Gerador de captions com IA (Claude Haiku).
 *
 * Inspirado no MoneyPrinterTurbo: em vez de template fixo,
 * usa LLM para criar legenda viral e persuasiva por produto.
 * Fallback para template quando ANTHROPIC_API_KEY não configurado.
 */

const { callClaude } = require('../utils/llm');
const { withRetry }  = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('captioner');

const HASHTAGS = process.env.AFFILIATE_HASHTAGS
  || '#shopee #oferta #promocao #comprinhas #lojaonline #desconto #achados';
const CTA = process.env.AFFILIATE_CTA || '🔗 Link na bio!';

function formatBRL(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ─── Template fallback (sem API key) ─────────────────────────────────────────

function templateCaption(product) {
  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  return [
    `🛍️ ${product.name}`,
    '',
    discount >= 5
      ? `🔥 De ${formatBRL(product.price_original)} por apenas ${formatBRL(product.price_discount)} — ${discount}% OFF!`
      : `💰 Por apenas ${formatBRL(product.price_discount)}`,
    '',
    CTA,
    '',
    product.short_desc ? `📦 ${product.short_desc.substring(0, 150)}` : '',
    '',
    HASHTAGS,
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Caption com IA ───────────────────────────────────────────────────────────

async function aiCaption(product) {
  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  const priceInfo = discount >= 5
    ? `De ${formatBRL(product.price_original)} por ${formatBRL(product.price_discount)} (${discount}% OFF)`
    : `Por ${formatBRL(product.price_discount)}`;

  const system = `Você é um especialista em marketing digital brasileiro para Instagram, focado em produtos de afiliados Shopee.
Crie legendas virais que geram cliques e conversões. Escreva em português brasileiro informal e entusiasmado.
Use emojis estrategicamente. A primeira frase deve ser um GANCHO que para o scroll.
Mantenha entre 120-200 palavras no total. Não inclua hashtags (elas serão adicionadas separadamente).`;

  const user = `Produto: ${product.name}
Preço: ${priceInfo}
Comissão afiliado: ${product.commission_pct}%
Descrição: ${product.short_desc || 'Produto de alta qualidade'}

Crie uma legenda para Instagram Reels que:
1. Começa com gancho de atenção irresistível (1 linha curta em CAPS ou com emoji impactante)
2. Destaca o desconto/preço de forma emocional
3. Lista 2-3 benefícios principais em bullets com emoji
4. Termina com urgência + CTA: "${CTA}"
Não use hashtags no texto.`;

  const text = await withRetry(
    () => callClaude({ system, user, maxTokens: 400 }),
    { maxAttempts: 2, baseDelayMs: 2000, context: 'ai-caption' }
  );

  return `${text}\n\n${HASHTAGS}`;
}

// ─── Narração TTS (texto curto, ~10s) ────────────────────────────────────────

async function aiNarration(product) {
  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  if (!process.env.ANTHROPIC_API_KEY) {
    // Narração template
    const priceText = discount >= 5
      ? `De ${formatBRL(product.price_original)} por apenas ${formatBRL(product.price_discount)}! ${discount}% de desconto!`
      : `Por apenas ${formatBRL(product.price_discount)}!`;
    return `${product.name.substring(0, 40)}! ${priceText} Acesse o link na bio e garanta o seu agora!`;
  }

  const text = await withRetry(
    () => callClaude({
      system: 'Crie narração curta (máximo 2 frases, 15 segundos de fala) para vídeo do Instagram Reels em português BR informal. Seja entusiasmado e direto.',
      user: `Produto: ${product.name}
${discount >= 5 ? `${discount}% OFF — de ${formatBRL(product.price_original)} por ${formatBRL(product.price_discount)}` : `Por ${formatBRL(product.price_discount)}`}
Escreva apenas o texto de narração, sem marcações.`,
      maxTokens: 100,
    }),
    { maxAttempts: 2, baseDelayMs: 1000, context: 'ai-narration' }
  );

  return text;
}

// ─── Exportação principal ─────────────────────────────────────────────────────

async function generateCaption(product) {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.debug('ANTHROPIC_API_KEY não configurado — usando template');
    return { caption: templateCaption(product), source: 'template' };
  }

  try {
    const caption = await aiCaption(product);
    log.info(`Caption IA gerado para [${product.id}]`);
    return { caption, source: 'ai' };
  } catch (err) {
    log.warn('Falha no caption IA, usando template', { error: err.message });
    return { caption: templateCaption(product), source: 'template-fallback' };
  }
}

module.exports = { generateCaption, aiNarration, templateCaption };
