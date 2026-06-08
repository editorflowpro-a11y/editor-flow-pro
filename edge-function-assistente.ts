import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LIMITES: Record<string, number> = { basic: 5, pro: 25, premium: 100 }

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: CORS })
  }

  // Lê variáveis de ambiente dentro do handler
  const GEMINI_KEY     = Deno.env.get('GEMINI_API_KEY') ?? ''
  const SB_URL         = Deno.env.get('SUPABASE_URL') ?? ''
  const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!GEMINI_KEY) return json({ erro: 'Chave Gemini não configurada. Adicione GEMINI_API_KEY nos Secrets da função.' })

  // ── Autenticação ──
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ erro: 'Não autenticado.' }, 401)

  const sb = createClient(SB_URL, SB_SERVICE_KEY)
  const { data: { user }, error: authErr } = await sb.auth.getUser(auth.replace('Bearer ', ''))
  if (authErr || !user) return json({ erro: 'Token inválido.' }, 401)

  // ── Plano e limite (considera trial Pro ativo) ──
  const { data: asn } = await sb.from('assinantes').select('plano,trial_ends').eq('email', user.email!).single()
  let plano = (asn?.plano ?? 'basic').toLowerCase()
  const trialAtivo = asn?.trial_ends && new Date(asn.trial_ends) > new Date()
  if (trialAtivo && plano === 'basic') plano = 'pro'
  const limite = LIMITES[plano] ?? 5

  // ── Uso de hoje ──
  const hoje = new Date().toISOString().split('T')[0]
  const { data: uso } = await sb.from('ia_uso').select('count').eq('user_id', user.id).eq('dia', hoje).maybeSingle()
  const usado = (uso?.count as number) ?? 0

  if (usado >= limite) {
    return json({ erro: `Limite de ${limite} mensagens de IA atingido hoje (plano ${plano}). Faça upgrade para continuar.` })
  }

  // ── Pergunta ──
  let pergunta = ''
  try { pergunta = ((await req.json())?.pergunta ?? '').trim() } catch { return json({ erro: 'Requisição inválida.' }, 400) }
  if (!pergunta) return json({ erro: 'Pergunta vazia.' }, 400)

  // ── Contexto do usuário ──
  const [{ data: projetos }, { data: clientes }, { data: gastos }] = await Promise.all([
    sb.from('projetos').select('nome,status,valor,prazo,cliente,tipo').eq('user_id', user.id).limit(100),
    sb.from('clientes').select('nome').eq('user_id', user.id).limit(50),
    sb.from('gastos').select('nome,valor,categoria').eq('user_id', user.id).limit(100),
  ])

  const dataHoje = new Date().toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
  const totalGastos = gastos?.reduce((s:number,g:any)=>s+(Number(g.valor)||0),0)??0
  const totalRecebido = projetos?.filter((p:any)=>p.status==='Pago').reduce((s:number,p:any)=>s+(Number(p.valor)||0),0)??0
  const ctx = `Hoje: ${dataHoje}.
PROJETOS (${projetos?.length??0} total): ${JSON.stringify(projetos??[])}
CLIENTES (${clientes?.length??0}): ${clientes?.map((c:any)=>c.nome).join(', ')||'Nenhum'}
GASTOS (${gastos?.length??0} registros, total R$${totalGastos.toFixed(2)}): ${JSON.stringify(gastos??[])}
RESUMO FINANCEIRO: Total recebido (projetos Pagos) = R$${totalRecebido.toFixed(2)} | Total gasto = R$${totalGastos.toFixed(2)} | Lucro líquido = R$${(totalRecebido-totalGastos).toFixed(2)}`

  // ── Gemini ──
  const gemRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Você é Flow IA, assistente financeiro especializado para editores de vídeo freelancer brasileiros dentro do app Editor Flow Pro.

REGRAS IMPORTANTES:
- Responda SEMPRE em português do Brasil
- NUNCA corte a resposta no meio — complete sempre o raciocínio
- Use os dados reais do usuário para responder com precisão
- "Gastos" e "despesas" se referem à tabela GASTOS do usuário (equipamentos, software, assistência, etc.) — não confunda com custos do próprio app
- Quando perguntar sobre gastos com algo específico (ex: "assistência", "adobe", "equipamento"), busque nos registros de GASTOS pelo campo "nome" ou "categoria"
- Faça cálculos quando necessário usando os valores dos dados
- Use listas e formatação quando ajudar na clareza
- Seja direto e objetivo

DADOS REAIS DO USUÁRIO:
${ctx}

PERGUNTA: ${pergunta}` }] }],
        // thinkingBudget: 0 desliga o "raciocínio interno" do gemini-2.5-flash,
        // que consumia o orçamento de tokens e cortava a resposta no meio.
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.5,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  )

  if (!gemRes.ok) {
    const errText = await gemRes.text()
    console.error('Gemini erro:', gemRes.status, errText)
    return json({ erro: `Gemini (${gemRes.status}): ${errText.slice(0, 300)}` })
  }

  const gemData = await gemRes.json()
  const cand = gemData?.candidates?.[0]
  // junta todas as partes (a resposta pode vir fragmentada em vários parts)
  let resposta = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
  if (!resposta) resposta = 'Sem resposta.'
  // se ainda assim a API truncar por limite, avisa de forma transparente
  if (cand?.finishReason === 'MAX_TOKENS' && resposta !== 'Sem resposta.') {
    resposta += '\n\n[resposta longa — peça "continue" para o restante]'
  }

  // ── Atualiza contador ──
  await sb.from('ia_uso').upsert({ user_id: user.id, dia: hoje, count: usado + 1 }, { onConflict: 'user_id,dia' })

  return json({ resposta, restante: limite - usado - 1, plano })
})
