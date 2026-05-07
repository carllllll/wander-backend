require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const IntaSend = require('intasend-node');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const intasend = new IntaSend(
  process.env.INSTASEND_PUBLISHABLE_KEY,
  process.env.INSTASEND_API_TOKEN,
  false // true = sandbox, false = live
);

// ─── TRIPS ───────────────────────────────────────────

app.get('/trips', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .order('start_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/trips', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .insert([req.body])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/trips/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/trips/:id', async (req, res) => {
  const { error } = await supabase
    .from('trips')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BOOKINGS ────────────────────────────────────────

app.get('/bookings', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/bookings', async (req, res) => {
  const { trip_id, name, email, phone, count, notes, payment_method } = req.body;

  // 1. Get the trip
  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('*')
    .eq('id', trip_id)
    .single();

  if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found' });

  // 2. Check availability
  const avail = trip.spots - (trip.booked || 0);
  if (count > avail) return res.status(400).json({ error: `Only ${avail} spot(s) left` });

  // 3. Save booking as pending
  const { data: booking, error: bookErr } = await supabase
    .from('bookings')
    .insert([{
      trip_id,
      trip_name: trip.name,
      name, email, phone, notes,
      count,
      total: trip.price * count,
      status: 'pending'
    }])
    .select()
    .single();

  if (bookErr) return res.status(500).json({ error: bookErr.message });

  // 4. Initiate payment
  try {
    const collection = intasend.collection();
    let paymentResponse;

    if (payment_method === 'mpesa') {
      // M-Pesa STK Push via SDK
      paymentResponse = await collection.mpesaStkPush({
        first_name:   name.split(' ')[0],
        last_name:    name.split(' ')[1] || '',
        email:        email,
        host:         'https://wander-backend-p970.onrender.com',
        amount:       trip.price * count,
        phone_number: phone,
        api_ref:      booking.id
      });
    } else {
      // Card — direct REST call to IntaSend
      const checkoutRes = await axios.post(
        'https://sandbox.intasend.com/api/v1/checkout/',
        {
          public_key:   process.env.INSTASEND_PUBLISHABLE_KEY,
          amount:       trip.price * count,
          currency:     'KES',
          email:        email,
          first_name:   name.split(' ')[0],
          last_name:    name.split(' ')[1] || '',
          api_ref:      booking.id,
          redirect_url: 'https://your-site.netlify.app' // ← update this to your site URL
        }
      );
      paymentResponse = checkoutRes.data;
    }

    // 5. Save payment reference
    const invoiceId = paymentResponse?.invoice?.invoice_id || paymentResponse?.id;
    const paymentUrl = paymentResponse?.url || null;

    await supabase
      .from('bookings')
      .update({ payment_ref: invoiceId })
      .eq('id', booking.id);

    // 6. Return to frontend
    res.json({
      booking_id:  booking.id,
      payment_url: paymentUrl,
      invoice_id:  invoiceId
    });

  } catch (err) {
    console.error('Instasend error:', err);
    res.status(500).json({ error: 'Payment initiation failed', detail: err.message });
  }
});

// ─── WEBHOOK ─────────────────────────────────────────
// Register this URL in IntaSend dashboard → Settings → Webhooks:
// https://wander-backend-p970.onrender.com/webhook/instasend

app.post('/webhook/instasend', async (req, res) => {
  console.log('Webhook received:', req.body);

  // Verify challenge
  const { invoice_id, state, challenge } = req.body;
  if (challenge !== process.env.INSTASEND_CHALLENGE) {
    console.log('Invalid challenge:', challenge);
    return res.sendStatus(401);
  }

  if (state !== 'COMPLETE') return res.sendStatus(200);

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('payment_ref', invoice_id)
    .single();

  if (error || !booking) {
    console.log('Booking not found for invoice:', invoice_id);
    return res.sendStatus(200);
  }

  await supabase
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', booking.id);

  await supabase.rpc('decrement_spots', {
    trip_id: booking.trip_id,
    amount:  booking.count
  });

  console.log(`Booking ${booking.id} confirmed, ${booking.count} spot(s) decremented`);
  res.sendStatus(200);
});
// ─── START ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wander API running on port ${PORT}`));