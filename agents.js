/**
 * Agentes Resolutivos — definições dos agentes de marketing do arOS (versão privada).
 *
 * Cada agente encapsula um "sistema" de Marketing Raiz: recebe alguns campos
 * simples do usuário (Tecnologia Zero Prompt — sem prompt manual) e monta
 * internamente um prompt completo para a IA gerar o entregável pronto pra vender.
 */

const AGENTS = [
  {
    id: 'copy-vsl',
    name: 'Copy que Vende',
    icon: '✍️',
    category: 'Copy',
    tagline: 'VSLs, cartas de vendas e páginas que convertem.',
    description:
      'Escreve copy de vendas persuasiva (VSL, sales page, headline) usando gatilhos de Marketing Raiz.',
    fields: [
      { name: 'produto', label: 'Produto / Oferta', placeholder: 'Ex: Curso de tráfego pago para dentistas', type: 'text', required: true },
      { name: 'publico', label: 'Público-alvo', placeholder: 'Ex: Dentistas que querem lotar a agenda', type: 'text', required: true },
      { name: 'formato', label: 'Formato', type: 'select', options: ['Carta de vendas', 'Roteiro de VSL', 'Página de vendas', 'Headline + Lead'], required: true },
      { name: 'dor', label: 'Principal dor / desejo', placeholder: 'Ex: Cansado de depender de indicação', type: 'textarea', required: false }
    ],
    buildPrompt: (i) => `Você é um copywriter sênior especialista em Marketing Raiz e resposta direta, treinado em campanhas que já geraram mais de R$100 milhões em vendas.

Escreva uma copy de vendas no formato "${i.formato}" para a seguinte oferta.

Produto/Oferta: ${i.produto}
Público-alvo: ${i.publico}
${i.dor ? `Principal dor/desejo: ${i.dor}` : ''}

Requisitos:
- Comece por uma headline magnética e uma lead que fisga nos 3 primeiros segundos.
- Use gatilhos mentais (prova, autoridade, urgência, específico > genérico).
- Trabalhe a promessa, o mecanismo único, as objeções e uma CTA clara.
- Português do Brasil, tom direto e humano, sem clichês vazios.
- Entregue pronto para publicar, formatado em markdown.`
  },
  {
    id: 'carrossel',
    name: 'Carrossel Viral',
    icon: '🎠',
    category: 'Social',
    tagline: 'Carrosséis de venda para Instagram em minutos.',
    description:
      'Cria o roteiro completo de um carrossel de Instagram (slide a slide) focado em engajar e vender.',
    fields: [
      { name: 'tema', label: 'Tema do carrossel', placeholder: 'Ex: 5 erros que matam suas vendas', type: 'text', required: true },
      { name: 'nicho', label: 'Nicho / Perfil', placeholder: 'Ex: Coach de emagrecimento', type: 'text', required: true },
      { name: 'slides', label: 'Número de slides', type: 'select', options: ['5', '7', '10'], required: true },
      { name: 'objetivo', label: 'Objetivo', type: 'select', options: ['Gerar salvamentos', 'Gerar comentários', 'Levar pro link/DM', 'Autoridade'], required: true }
    ],
    buildPrompt: (i) => `Você é um especialista em conteúdo viral para Instagram e Marketing Raiz.

Crie o roteiro completo de um carrossel de ${i.slides} slides.

Tema: ${i.tema}
Nicho/Perfil: ${i.nicho}
Objetivo principal: ${i.objetivo}

Requisitos:
- Slide 1 = capa com um gancho (hook) impossível de ignorar.
- Um slide por bloco, com o texto exato que vai na arte + sugestão visual entre colchetes.
- Slide final com CTA alinhada ao objetivo.
- Sugira também a legenda do post e 5 hashtags.
- Português do Brasil, linguagem de rede social, escaneável. Formate em markdown.`
  },
  {
    id: 'funil',
    name: 'Funil de Alta Conversão',
    icon: '🧲',
    category: 'Estratégia',
    tagline: 'Funil completo mapeado — LP, VSL, e-mails e upsell.',
    description:
      'Mapeia um funil de vendas ponta a ponta pronto para executar, com cada etapa e o papel dela.',
    fields: [
      { name: 'oferta', label: 'Oferta principal', placeholder: 'Ex: Mentoria de 12 semanas', type: 'text', required: true },
      { name: 'ticket', label: 'Ticket', type: 'select', options: ['Low ticket (até R$100)', 'Mid ticket (R$100–2mil)', 'High ticket (R$2mil+)'], required: true },
      { name: 'trafego', label: 'Origem de tráfego', type: 'select', options: ['Tráfego pago', 'Orgânico / Social', 'Lista de e-mail', 'Lançamento'], required: true },
      { name: 'meta', label: 'Meta de faturamento', placeholder: 'Ex: R$50 mil no primeiro mês', type: 'text', required: false }
    ],
    buildPrompt: (i) => `Você é um estrategista de funis de resposta direta (Marketing Raiz).

Monte um funil de vendas completo e pronto para executar.

Oferta principal: ${i.oferta}
Ticket: ${i.ticket}
Origem de tráfego: ${i.trafego}
${i.meta ? `Meta: ${i.meta}` : ''}

Entregue:
1. Diagrama do funil em etapas (topo → fundo), cada etapa com objetivo e KPI.
2. Estrutura da página de captura e da página de vendas (seção a seção).
3. Sequência de e-mails (assunto + ideia de cada e-mail).
4. Estratégia de upsell/downsell e order bump.
5. Projeção simples de números para bater a meta.
Português do Brasil, prático e acionável. Formate em markdown.`
  },
  {
    id: 'ads',
    name: 'Anúncios que Escalam',
    icon: '📣',
    category: 'Tráfego',
    tagline: 'Ganchos, ângulos e CTAs focados em conversão.',
    description:
      'Gera criativos de anúncio (headline, corpo, CTA) em vários ângulos para reduzir o custo por lead.',
    fields: [
      { name: 'produto', label: 'Produto / Oferta', placeholder: 'Ex: App de finanças pessoais', type: 'text', required: true },
      { name: 'plataforma', label: 'Plataforma', type: 'select', options: ['Meta (Facebook/Instagram)', 'Google', 'YouTube', 'TikTok'], required: true },
      { name: 'publico', label: 'Público', placeholder: 'Ex: Jovens endividados de 25–35 anos', type: 'text', required: true },
      { name: 'variacoes', label: 'Nº de variações', type: 'select', options: ['3', '5', '8'], required: true }
    ],
    buildPrompt: (i) => `Você é um media buyer e copywriter de performance especialista em Marketing Raiz.

Crie ${i.variacoes} variações de anúncio para ${i.plataforma}.

Produto/Oferta: ${i.produto}
Público: ${i.publico}

Para cada variação entregue:
- Ângulo (ex: dor, benefício, curiosidade, prova social, contraste).
- Headline (chamada principal).
- Corpo do anúncio.
- CTA.
Comece cada variação com o ângulo usado. Português do Brasil, direto ao ponto. Formate em markdown.`
  },
  {
    id: 'youtube',
    name: 'Roteiro YouTube',
    icon: '🎬',
    category: 'Conteúdo',
    tagline: 'Roteiros que seguram a retenção do início ao fim.',
    description:
      'Escreve roteiros de vídeo para YouTube com gancho, retenção e CTA, prontos para gravar.',
    fields: [
      { name: 'tema', label: 'Tema do vídeo', placeholder: 'Ex: Como sair das dívidas em 6 meses', type: 'text', required: true },
      { name: 'duracao', label: 'Duração alvo', type: 'select', options: ['Shorts (até 60s)', '3–5 min', '8–12 min', '15 min+'], required: true },
      { name: 'canal', label: 'Estilo do canal', placeholder: 'Ex: Educação financeira descontraída', type: 'text', required: true },
      { name: 'cta', label: 'CTA desejada', placeholder: 'Ex: Inscrever no curso gratuito', type: 'text', required: false }
    ],
    buildPrompt: (i) => `Você é um roteirista de YouTube especialista em retenção e Marketing Raiz.

Escreva um roteiro de vídeo (${i.duracao}).

Tema: ${i.tema}
Estilo do canal: ${i.canal}
${i.cta ? `CTA desejada: ${i.cta}` : ''}

Estrutura:
- HOOK (0–15s): frase de abertura que impede o espectador de sair.
- Desenvolvimento em blocos, cada bloco com um "loop aberto" para segurar a retenção.
- Momento de CTA natural.
- Encerramento com gancho para o próximo vídeo.
Escreva o texto falado + indicações [de corte/visual] entre colchetes. Português do Brasil. Formate em markdown.`
  },
  {
    id: 'oferta',
    name: 'Oferta Irresistível',
    icon: '💎',
    category: 'Estratégia',
    tagline: 'Estruture uma oferta que o mercado não consegue recusar.',
    description:
      'Constrói uma oferta no estilo "Grand Slam": promessa, stack de valor, bônus, garantia e ancoragem.',
    fields: [
      { name: 'produto', label: 'O que você vende', placeholder: 'Ex: Programa de emagrecimento de 90 dias', type: 'text', required: true },
      { name: 'resultado', label: 'Resultado prometido', placeholder: 'Ex: Perder 10kg sem dieta maluca', type: 'text', required: true },
      { name: 'preco', label: 'Preço pretendido', placeholder: 'Ex: R$ 1.997', type: 'text', required: false }
    ],
    buildPrompt: (i) => `Você é um especialista em criação de ofertas de alto valor (Marketing Raiz / Grand Slam Offer).

Monte uma oferta irresistível.

Produto: ${i.produto}
Resultado prometido: ${i.resultado}
${i.preco ? `Preço pretendido: ${i.preco}` : ''}

Entregue:
1. Grande promessa (headline da oferta).
2. Mecanismo único (por que funciona / por que é diferente).
3. Stack de valor (itens entregáveis com valor ancorado em cada um).
4. Bônus estratégicos que quebram objeções.
5. Garantia forte.
6. Justificativa de preço e ancoragem.
Português do Brasil, persuasivo e concreto. Formate em markdown.`
  },
  {
    id: 'email',
    name: 'Sequência de E-mail',
    icon: '📧',
    category: 'Copy',
    tagline: 'Sequências de e-mail que aquecem e vendem.',
    description:
      'Escreve uma sequência de e-mails (nutrição ou lançamento) com assunto e corpo prontos.',
    fields: [
      { name: 'objetivo', label: 'Objetivo da sequência', type: 'select', options: ['Nutrição / relacionamento', 'Lançamento', 'Carrinho aberto', 'Recuperação de carrinho'], required: true },
      { name: 'oferta', label: 'Oferta / Assunto', placeholder: 'Ex: Turma nova da mentoria', type: 'text', required: true },
      { name: 'qtd', label: 'Nº de e-mails', type: 'select', options: ['3', '5', '7'], required: true }
    ],
    buildPrompt: (i) => `Você é um e-mail copywriter de resposta direta (Marketing Raiz).

Escreva uma sequência de ${i.qtd} e-mails com o objetivo: ${i.objetivo}.

Oferta/Assunto central: ${i.oferta}

Para cada e-mail entregue:
- Dia sugerido de envio.
- Linha de assunto (+ 1 variação).
- Corpo completo do e-mail.
- Objetivo específico daquele e-mail na jornada.
Português do Brasil, tom de conversa 1:1, com storytelling e CTA. Formate em markdown.`
  },
  {
    id: 'ideias',
    name: 'Ideias Virais',
    icon: '💡',
    category: 'Conteúdo',
    tagline: 'Um mês de conteúdo que vende, em um clique.',
    description:
      'Gera um banco de ideias de conteúdo (ganchos + formatos) alinhado ao seu nicho e oferta.',
    fields: [
      { name: 'nicho', label: 'Nicho', placeholder: 'Ex: Nutrição esportiva', type: 'text', required: true },
      { name: 'oferta', label: 'O que você quer vender', placeholder: 'Ex: Consultoria de dieta', type: 'text', required: true },
      { name: 'qtd', label: 'Quantidade de ideias', type: 'select', options: ['10', '20', '30'], required: true }
    ],
    buildPrompt: (i) => `Você é um estrategista de conteúdo viral orientado a vendas (Marketing Raiz).

Gere ${i.qtd} ideias de conteúdo para o nicho "${i.nicho}", conectadas a vender "${i.oferta}".

Para cada ideia entregue em uma tabela:
- Gancho (hook) pronto.
- Formato ideal (Reels, Carrossel, Story, YouTube, Post).
- Objetivo (topo/meio/fundo de funil).
Varie entre educar, quebrar objeção, prova social e desejo. Português do Brasil. Formate em markdown com tabela.`
  }
];

function listAgents() {
  return AGENTS.map(({ id, name, icon, category, tagline, description, fields }) => ({
    id, name, icon, category, tagline, description, fields
  }));
}

function getAgent(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

module.exports = { AGENTS, listAgents, getAgent };
