// Everyday questions for Conversation mode. These are not baked yet.
// scripts/voice-lines.mjs lists them for the coach voice, and clipFile()
// is the path a later Aurora bake would fill. Until that file exists,
// the question is spoken by the cloud aurora voice, then device speech.
// Keep the text free of < and >, because saved progress rejects markup.

// Spoken when the road covers the answer. No baked clip: one cloud Aurora line, then device speech.
export const CONVERSATION_NOISY_LINE = "I couldn't hear that clearly, let's try another.";
// A noisy stretch may stay on the question once, then the next question is asked.
export const CONVERSATION_NOISY_CAP = 2;

export const CONVERSATION_PROMPTS = [
  'What did you have for breakfast?',
  'Tell me about your weekend.',
  'What are you looking forward to today?',
  'How did you sleep last night?',
  'What is the weather like where you are?',
  'Tell me about a meal you love.',
  'What did you do yesterday?',
  'Who is someone you like talking to?',
  'What is a song you have heard lately?',
  'Tell me about your morning.',
  'What is something you want to do this week?',
  'How is your day going so far?',
  'What did you wear today?',
  'Tell me about a place you like.',
  'What is a show you have been watching?',
  'How do you take your coffee or tea?',
  'What is on your mind right now?',
  'Tell me about a friend.',
  'What did you cook recently?',
  'Where would you like to go next?',
  'What made you smile today?',
  'Tell me about your evening plans.',
  'What is a book or a story you like?',
  'How was the trip in today?',
  'What is something you are learning?',
  'Tell me about your favorite season.',
  'What did you do for lunch?',
  'Who did you talk to today?',
  'What is a small win from this week?',
  'Tell me about your home.',
  'What are you having for dinner?',
  'How do you like to spend a Sunday?',
  'What is a habit you are keeping?',
  'Tell me about a pet or a plant you like.',
  'What is the last errand you ran?',
  'How are you feeling in your voice today?',
  'What would you tell a friend about your week?',
  'Tell me about a walk you took.',
  'What is something kind you noticed?',
  'What are you grateful for today?'
];
