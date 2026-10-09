import type { AgentInput } from '../../lib/api';

const base = (overrides: Partial<AgentInput>): AgentInput => ({
  name: 'New agent',
  instructions: '',
  greeting: 'Hello! How can I help you today?',
  languages: ['English', 'Hindi', 'Hinglish'],
  engine: 'realtime',
  voice: {
    realtime: { model: '', voice: '' },
    stt: { provider: 'openai', model: '' },
    llm: { provider: 'anthropic', model: '' },
    tts: { provider: 'openai', model: '', voice: '' },
    language: '',
  },
  tools: { knowledge: true, transfer: true, endCall: true, whatsappMessage: true, workflows: [] },
  notify: { summary: true, whatsappTo: '' },
  ...overrides,
});

export interface PersonaFields {
  business: string;
  about: string;
  tone: 'friendly' | 'professional' | 'warm' | 'energetic';
  goals: string[];
  extra: string;
}

export const GOALS = [
  'Answer questions about services, prices and opening hours',
  'Book, change or cancel appointments',
  'Take orders or reservations',
  'Qualify new leads and collect their details',
  'Take a message when the team is busy',
  'Handle complaints calmly and pass them to the team',
];

const TONES: Record<PersonaFields['tone'], string> = {
  friendly: 'friendly and relaxed, like a helpful neighbour',
  professional: 'polite, clear and professional',
  warm: 'warm, patient and reassuring',
  energetic: 'upbeat and enthusiastic',
};

/** The persona builder: a few answers → instructions the owner can still edit. */
export function writeInstructions(f: PersonaFields): string {
  const lines = [
    `You are the voice assistant of ${f.business || 'our business'}. You answer phone calls on WhatsApp.`,
    f.about.trim() && `About the business: ${f.about.trim()}`,
    `Your tone is ${TONES[f.tone]}.`,
    f.goals.length && `Your job:\n${f.goals.map((g) => `- ${g}`).join('\n')}`,
    "Ask for the caller's name early and use it. When you collect details (name, date, time, phone), repeat them back to confirm.",
    'If a question is outside what you know, say so honestly and offer to have the team call back.',
    f.extra.trim(),
  ];
  return lines.filter(Boolean).join('\n\n');
}

export const TEMPLATES: Array<{
  id: string;
  title: string;
  description: string;
  agent: AgentInput;
}> = [
  {
    id: 'receptionist',
    title: 'Receptionist',
    description: 'Answers questions, books appointments, takes messages.',
    agent: base({
      name: 'Receptionist',
      greeting: 'Hello, thank you for calling! How can I help you today?',
      instructions: writeInstructions({
        business: 'our business',
        about: '',
        tone: 'friendly',
        goals: [GOALS[0]!, GOALS[1]!, GOALS[4]!],
        extra: '',
      }),
    }),
  },
  {
    id: 'clinic',
    title: 'Clinic front desk',
    description: 'Appointments and timings; never gives medical advice.',
    agent: base({
      name: 'Clinic front desk',
      greeting: 'Namaste, you have reached the clinic. How may I help you?',
      instructions: writeInstructions({
        business: 'the clinic',
        about: '',
        tone: 'warm',
        goals: [GOALS[0]!, GOALS[1]!, GOALS[4]!],
        extra:
          'Never give medical advice or diagnoses. For emergencies, tell the caller to go to the nearest hospital or call 112 immediately.',
      }),
    }),
  },
  {
    id: 'restaurant',
    title: 'Restaurant',
    description: 'Table reservations, menu questions, takeaway orders.',
    agent: base({
      name: 'Restaurant host',
      greeting: 'Hello! Thanks for calling. Would you like to book a table or order food?',
      instructions: writeInstructions({
        business: 'the restaurant',
        about: '',
        tone: 'energetic',
        goals: [GOALS[0]!, GOALS[2]!],
        extra:
          'For orders, confirm every item, the quantity, the address and the total before finishing.',
      }),
    }),
  },
  {
    id: 'sales',
    title: 'Sales / lead qualifier',
    description: 'Understands what callers need and collects their details.',
    agent: base({
      name: 'Sales assistant',
      greeting: 'Hi! Thanks for your interest. What are you looking for?',
      instructions: writeInstructions({
        business: 'our company',
        about: '',
        tone: 'professional',
        goals: [GOALS[0]!, GOALS[3]!],
        extra:
          'Find out what they need, their budget and when they want to start. Offer a call back from the team.',
      }),
    }),
  },
  {
    id: 'support',
    title: 'Customer support',
    description: 'Solves common problems from your FAQ, escalates the rest.',
    agent: base({
      name: 'Support',
      greeting: 'Hello, customer support here. What can I help you with?',
      instructions: writeInstructions({
        business: 'our company',
        about: '',
        tone: 'warm',
        goals: [GOALS[0]!, GOALS[5]!, GOALS[4]!],
        extra: 'Ask for the order or booking number first when it helps.',
      }),
    }),
  },
  {
    id: 'blank',
    title: 'Start from scratch',
    description: 'An empty agent.',
    agent: base({ name: 'My agent' }),
  },
];
