// api.js (FINAL)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const serverless = require('serverless-http');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// 🔐 SECRETS (.env em produção)
const VERSO_SK = process.env.VERSO_SK || 'sk_XXXX';
const VERSO_PK = process.env.VERSO_PK || 'pk_YYYY';
const VERSO_AUTH_HEADER = {
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: `Basic ${Buffer.from(`${VERSO_SK}:${VERSO_PK}`).toString('base64')}`,
};

const fbPixelId = process.env.FB_PIXEL_ID || 'PIXEL_ID_AQUI';
const fbAccessToken = process.env.FB_ACCESS_TOKEN || 'FB_TOKEN_AQUI';
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || 'UTMIFY_TOKEN_AQUI';
const POSTBACK_URL = process.env.POSTBACK_URL || 'https://seu-dominio.com/api/pix-webhook';

// 🔧 Helpers
function hashSHA256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex');
}

// ===================== GERAR PIX (Gate novo / Verso) =====================
app.post('/api/gerar-pix', async (req, res) => {
  try {
    const { nome, cpf, email, celular, valor, produto, campanha } = req.body;

    // ✅ Validações (mantidas)
    if (!cpf || cpf.length !== 11 || !/^\d+$/.test(cpf)) {
      return res.status(400).json({ error: 'CPF inválido' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    if (!celular || celular.length < 10) {
      return res.status(400).json({ error: 'Celular inválido' });
    }
    if (!valor || isNaN(valor) || Number(valor) < 100) {
      // Assumindo "valor" em CENTAVOS; mínimo R$ 1,00
      return res.status(400).json({ error: 'Valor inválido' });
    }

    const amount = parseInt(valor, 10); // centavos

    // Payload conforme VersoPayments
    const payload = {
      paymentMethod: 'pix',
      ip: req.ip || '127.0.0.1',
      pix: { expiresInDays: 2 },
      items: [
        {
          title: produto || `Pedido ${nome}`,
          unitPrice: amount,
          quantity: 1,
          tangible: false,
        },
      ],
      amount,
      externalRef: `pedido-${uuidv4()}`,
      customer: {
        name: nome,
        email,
        phone: celular,
        document: { type: 'cpf', number: cpf },
      },
      postbackUrl: POSTBACK_URL,
      traceable: true,
      metadata: JSON.stringify({
        origem: 'site',
        campanha: campanha || 'default',
      }),
    };

    const rr = await axios.post(
      'https://api.versopayments.com/api/v1/transactions',
      payload,
      { headers: VERSO_AUTH_HEADER }
    );

    const qrcodeText = rr.data?.data?.pix?.qrcode;
    const id = rr.data?.data?.id || rr.data?.objectId || null;
    const secureUrl = rr.data?.data?.secureUrl || '';

    if (!qrcodeText) {
      console.error('QR ausente:', rr.data);
      return res.status(500).json({ error: 'QR Code (texto) ausente no gateway' });
    }

    // 🔙 RESPOSTA compatível com teu front (pagamento.js / qrcode.js)
    res.json({
      raw: {
        pix: { qrcode: qrcodeText },
        secureUrl,
        id,
      },
    });

    // (Opcional) Disparos de pixel de checkout aqui — não bloqueiam a resposta
    try {
      await axios.post(`https://graph.facebook.com/v18.0/${fbPixelId}/events`, {
        data: [
          {
            event_name: 'InitiateCheckout',
            event_time: Math.floor(Date.now() / 1000),
            event_id: uuidv4(),
            action_source: 'website',
            user_data: {
              em: [hashSHA256(email)],
              ph: [hashSHA256(celular)],
            },
            custom_data: {
              currency: 'BRL',
              value: amount / 100, // reais
              content_name: produto,
            },
          },
        ],
        access_token: fbAccessToken,
      });
    } catch (fbErr) {
      console.warn('FB Pixel InitiateCheckout error:', fbErr.response?.data || fbErr.message);
    }
  } catch (err) {
    console.error('💥 ERRO AO GERAR PIX:', err.response?.data || err.message);
    res
      .status(err.response?.status || 500)
      .json({ error: 'Erro ao gerar Pix', details: err.response?.data || err.message });
  }
});

// ===================== WEBHOOK (Verso + compat) =====================
app.post('/api/pix-webhook', async (req, res) => {
  try {
    const body = req.body;

    const isVerso = !!body?.data;
    const status = isVerso ? body.data?.status : body?.status;
    const paymentMethod = isVerso ? body.data?.paymentMethod : body?.paymentMethod;

    if (status === 'paid' && (paymentMethod === 'pix' || !paymentMethod)) {
      const data = isVerso ? body.data : body;

      const email = data?.customer?.email || '';
      const celular = data?.customer?.phone || '';
      const produto = data?.items?.[0]?.title || 'Produto';
      const amountInCents = Number(data?.amount || 0);
      const amount = amountInCents / 100;

      // 📈 Facebook Purchase
      try {
        await axios.post(`https://graph.facebook.com/v18.0/${fbPixelId}/events`, {
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              event_id: uuidv4(),
              action_source: 'website',
              user_data: {
                em: [hashSHA256(email)],
                ph: [hashSHA256(celular)],
              },
              custom_data: {
                currency: 'BRL',
                value: amount, // reais
                content_name: produto,
              },
            },
          ],
          access_token: fbAccessToken,
        });
      } catch (fbErr) {
        console.warn('FB Pixel Purchase error:', fbErr.response?.data || fbErr.message);
      }

      // 🧾 UTMify
      try {
        await axios.post(
          'https://api.utmify.com.br/api-credentials/orders',
          {
            orderId: body.id || body.objectId || uuidv4(),
            platform: isVerso ? 'pix-verso' : 'pix-api',
            paymentMethod: 'pix',
            status: 'paid',
            createdAt:
              data?.created_at ||
              new Date().toISOString().slice(0, 19).replace('T', ' '),
            approvedDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
            refundedAt: null,
            customer: {
              name: data?.customer?.name || '',
              email,
              phone: celular,
              document: data?.customer?.document?.number || '',
              country: 'BR',
              ip: data?.customer?.ip || '0.0.0.0',
            },
            products: [
              {
                id: 'prod-pix',
                name: produto,
                planId: null,
                planName: null,
                quantity: 1,
                priceInCents: amountInCents,
              },
            ],
            trackingParameters: {
              utm_source: data?.tracking?.utm_source || null,
              utm_medium: data?.tracking?.utm_medium || null,
              utm_campaign: data?.tracking?.utm_campaign || null,
              utm_content: data?.tracking?.utm_content || null,
              utm_term: data?.tracking?.utm_term || null,
              src: null,
              sck: null,
            },
            commission: {
              totalPriceInCents: amountInCents,
              gatewayFeeInCents: 0,
              userCommissionInCents: amountInCents,
            },
            isTest: false,
          },
          { headers: { 'x-api-token': UTMIFY_TOKEN } }
        );
      } catch (uErr) {
        console.warn('UTMify error:', uErr.response?.data || uErr.message);
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (err) {
    console.error('Erro webhook:', err.message);
    res.status(500).json({ error: 'Erro Webhook' });
  }
});

// 🔥 Exportação Serverless
module.exports = app;
module.exports.handler = serverless(app);
