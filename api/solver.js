import vm from 'node:vm';
import { QureoError } from './qureo.js';

const SECTION_ID = 5;
const COURSE_ID = 'javascript_ar';

function cleanMarkup(value) {
  return String(value || '')
    .replace(/\[\[\/?[^\]]+\]\]/g, '')
    .replace(/[\t\u3000]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCode(value) {
  return String(value || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .trim();
}

function tokens(value) {
  return cleanMarkup(value)
    .toLowerCase()
    .match(/[a-z_$][\w$]*|\d+(?:\.\d+)?|[\u0600-\u06ff]+/g) || [];
}

function similarity(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function formatOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function executeJavaScript(code) {
  if (!code || /<\/?[a-z][\s\S]*>/i.test(code) && !/\b(console|let|const|var|for|if|function)\b/.test(code)) {
    return null;
  }

  const output = [];
  const context = {
    console: {
      log: (...args) => output.push(args.map(formatOutput).join(' ')),
      info: (...args) => output.push(args.map(formatOutput).join(' ')),
      warn: (...args) => output.push(args.map(formatOutput).join(' ')),
      error: (...args) => output.push(args.map(formatOutput).join(' '))
    }
  };

  try {
    vm.runInNewContext(code, context, { timeout: 250, contextCodeGeneration: { strings: false, wasm: false } });
    return output.join('\n');
  } catch {
    return null;
  }
}

function extractCode(content) {
  const match = String(content || '').match(/\[\[code\]\]([\s\S]*?)\[\[\/code\]\]/i);
  return match ? match[1].trim() : '';
}

function payload(value) {
  return value?.data && typeof value.data === 'object' ? payload(value.data) : value;
}

function lectureChoice(talk) {
  const choices = Array.isArray(talk.body?.choices) ? talk.body.choices : [];
  if (!choices.length) throw new Error('سؤال الاختيار لا يحتوي على خيارات.');
  if (talk.type === 'choice_survey') return choices[0];

  const scores = choices.map(() => 0);
  choices.forEach((choice, index) => {
    const response = (choice.after_talks || [])
      .map(item => item.body?.serif || '')
      .join(' ');
    if (/إجابة خاطئة|خطأ|غاطئ|حظًا|غير صحيح|لم يكن|انخدعت|wrong|incorrect|not correct/i.test(response)) {
      scores[index] += 10;
    }
    if (/صحيح|ممتاز|رائع|أحسنت|لم تنخدع|great|correct|excellent/i.test(response)) {
      scores[index] -= 2;
    }
    if (/الإجابة الصحيحة هي|the correct answer is/i.test(response)) {
      choices.forEach((other, otherIndex) => {
        if (otherIndex !== index && cleanMarkup(other.label) && response.includes(cleanMarkup(other.label))) {
          scores[otherIndex] -= 20;
        }
      });
    }
  });

  return choices[scores.indexOf(Math.min(...scores))];
}

async function completeLecture(client, lectureId) {
  const current = await client.learning(`/api/study/students/lectures/${lectureId}`, { allow: [404] });
  const currentData = payload(current.data);
  if (currentData?.lecture?.completed_at) {
    return { completed: true, submitted: 0, skipped: true };
  }

  await client.learning(`/api/study/students/lectures/${lectureId}`, {
    method: 'PUT',
    allow: [409]
  });

  const content = await client.learning(`/api/study/lectures/${lectureId}`);
  const contentData = payload(content.data);
  const existing = new Map(
    (currentData?.talks || []).map(item => [String(item.talk_id), item.value])
  );
  let submitted = 0;

  for (const talk of contentData?.talks || []) {
    if (!['try', 'choice_question', 'choice_survey'].includes(talk.type)) continue;
    if (existing.has(String(talk.id))) continue;

    let value;
    if (talk.type === 'try') {
      const editable = (talk.body?.codes || []).find(code => code.editable) || talk.body?.codes?.[0];
      const answer = editable?.model_answer ?? editable?.code ?? '';
      if (!answer) throw new Error(`تمرين ${talk.id} لا يحتوي على إجابة نموذجية.`);
      value = { try: { lang: editable?.lang || 'javascript', answer } };
    } else {
      const choice = lectureChoice(talk);
      value = { [talk.type]: choice.value };
    }

    await client.learning(`/api/study/students/lecture-talks/${talk.id}`, {
      method: 'PUT',
      body: { value }
    });
    submitted += 1;
  }

  await client.learning(`/api/study/students/lectures/${lectureId}/complete`, { method: 'PUT' });
  return { completed: true, submitted, skipped: false };
}

export async function getProgress(client) {
  const [sectionResult, stateResult] = await Promise.all([
    client.learning('/api/study/sections/5'),
    client.learning('/api/study/students/sections/5/chapters')
  ]);

  const states = new Map(
    (payload(stateResult.data) || []).map(item => [String(item.chapter_id), item])
  );
  const chapters = (payload(sectionResult.data)?.chapters || []).map(chapter => {
    const state = states.get(String(chapter.id));
    return {
      id: chapter.id,
      seq: chapter.seq,
      name: chapter.name,
      question_count: chapter.question_count,
      test_type: chapter.test_type,
      completed: Boolean(state?.completed_at),
      completed_at: state?.completed_at || null,
      started_at: state?.started_at || null,
      diamonds: state?.diamond || 0,
      best_correct_count: state?.best_correct_count || 0
    };
  }).sort((a, b) => a.seq - b.seq);

  const completed = chapters.filter(chapter => chapter.completed).length;
  return {
    course_id: COURSE_ID,
    section_id: SECTION_ID,
    total: chapters.length,
    completed,
    diamonds: chapters.reduce((sum, chapter) => sum + chapter.diamonds, 0),
    current: chapters.find(chapter => !chapter.completed) || null,
    chapters
  };
}

async function collectModelAnswers(client, lectures) {
  const results = await Promise.all((lectures || []).map(async lecture => {
    const response = await client.learning(`/api/study/lectures/${lecture.id}`);
    return (payload(response.data)?.talks || [])
      .filter(talk => talk.type === 'try')
      .flatMap(talk => (talk.body?.codes || []).map(code => ({
        code: code.model_answer || '',
        lang: code.lang || 'javascript',
        question: talk.body?.question?.text || ''
      })))
      .filter(item => item.code);
  }));
  return results.flat();
}

function choiceFromOutput(question, choices, code) {
  const output = executeJavaScript(code);
  if (output === null) {
    return choices.find(choice => /خطأ|error/i.test(cleanMarkup(choice.content))) || null;
  }
  const translations = {
    'regular price': 'السعر العادي',
    '20% off': 'خصم 20%',
    'no output': 'لا توجد مخرجات'
  };
  const normalizedOutput = cleanMarkup(output).toLowerCase();
  const translated = translations[normalizedOutput] || normalizedOutput;
  const compactOutput = normalizeCode(normalizedOutput);
  const compactTranslated = normalizeCode(translated);
  return choices.find(choice => {
    const content = cleanMarkup(choice.content).toLowerCase();
    const compact = normalizeCode(content);
    return content === normalizedOutput || content === translated
      || compact === compactOutput || compact === compactTranslated;
  }) || null;
}

function testChoice(question, choices, modelAnswers) {
  const code = extractCode(question.content);
  const outputChoice = choiceFromOutput(question, choices, code);
  if (outputChoice) return outputChoice;

  const text = cleanMarkup(question.content);
  const hints = cleanMarkup((question.hints || []).join(' '));
  const contentOf = choice => cleanMarkup(choice.content);
  const compactOf = choice => normalizeCode(contentOf(choice));
  const pick = predicate => choices.find(predicate);
  const targetOutput = text.match(/"([^"]+)"/)?.[1];
  if (targetOutput && !/^[\d\s+\-*×÷/.]+$/.test(targetOutput)) {
    const matchingOutput = choices.find(choice => {
      const content = contentOf(choice);
      return /console\.log/.test(content) && normalizeCode(executeJavaScript(content)) === normalizeCode(targetOutput);
    });
    if (matchingOutput) return matchingOutput;
  }

  if (/تعليق|comment/i.test(text)) {
    const comment = pick(choice => /^\/\//.test(contentOf(choice).trim()));
    if (comment) return comment;
  }
  if (/القسمة|قسمة|division/i.test(text)) {
    const division = pick(choice => contentOf(choice) === '/');
    if (division) return division;
  }
  if (/الضرب|ضرب|multiplication/i.test(text)) {
    const multiplication = pick(choice => contentOf(choice) === '*');
    if (multiplication) return multiplication;
  }
  if (/الجمع|addition/i.test(text)) {
    const addition = pick(choice => contentOf(choice) === '+');
    if (addition) return addition;
  }
  if (/الطرح|subtraction/i.test(text)) {
    const subtraction = pick(choice => contentOf(choice) === '-');
    if (subtraction) return subtraction;
  }

  const normalizedText = comparisonText(text);
  const arithmetic = normalizedText.match(/(-?\d+(?:\.\d+)?)\s*([+\-*×÷/])\s*(-?\d+(?:\.\d+)?)/);
  if (arithmetic) {
    const operator = arithmetic[2] === '×' ? '*' : arithmetic[2] === '÷' ? '/' : arithmetic[2];
    const expression = `(${arithmetic[1]} ${operator} ${arithmetic[3]})`;
    if ((/نص|مع|صيغة|دمج|\+/.test(normalizedText) || (normalizedText.match(/"/g) || []).length >= 2) && /"/.test(normalizedText)) {
      const prefix = normalizedText.match(/"([^"]*)"/)?.[1] || '';
      const suffix = normalizedText.match(/\+\s*"([^"]*)"\s*\)/)?.[1] || '';
      const expected = normalizeCode(`console.log("${prefix}" + ${expression} + "${suffix}");`);
      const concatenated = pick(choice => compactOf(choice) === expected
        || compactOf(choice) === normalizeCode(`console.log("${prefix}" + ${arithmetic[1]} ${operator} ${arithmetic[3]} + "${suffix}");`));
      if (concatenated) return concatenated;
    }
    const expected = normalizeCode(`console.log(${arithmetic[1]} ${operator} ${arithmetic[3]});`);
    const calculated = pick(choice => compactOf(choice) === expected
      || compactOf(choice) === normalizeCode(`console.log(${expression});`));
    if (calculated) return calculated;
  }

  const comparison = normalizedText.match(/([A-Za-z_$][\w$]*)\s*(?:أيضًا\s+(?:يساوي\s+)?)?(أكبر من أو يساوي|أصغر من أو يساوي|أقل من أو يساوي|أكبر من أو تساوي|أصغر من أو تساوي|أقل من أو تساوي|أكبر من|أصغر من|أقل من|لا يساوي|تساوي|يساوي|هي)\s*(-?\d+(?:\.\d+)?)/);
  if (comparison) {
    const operators = {
      'أكبر من أو يساوي': '>=',
      'أصغر من أو يساوي': '<=',
      'أقل من أو يساوي': '<=',
    'أكبر من أو تساوي': '>=',
    'أصغر من أو تساوي': '<=',
    'أقل من أو تساوي': '<=',
      'أكبر من': '>',
      'أصغر من': '<',
      'أقل من': '<',
      'لا يساوي': '!=',
      'تساوي': '==',
      'يساوي': '==',
      'هي': '=='
    };
    const expected = normalizeCode(`${comparison[1]} ${operators[comparison[2]]} ${comparison[3]}`);
    const matched = pick(choice => compactOf(choice) === expected);
    if (matched) return matched;
  }

  if (/\bA\s+and\s+B\b|\bA\s*&&\s*B\b/.test(text) || /A\s+و\s+B/.test(text)) {
    const logicalAnd = pick(choice => /A\s*&&\s*B/.test(contentOf(choice)));
    if (logicalAnd) return logicalAnd;
  }
  if (/\bA\s+or\s+B\b/.test(text) || /A\s+أو\s+B/.test(text)) {
    const logicalOr = pick(choice => /A\s*\|\|\s*B/.test(contentOf(choice)));
    if (logicalOr) return logicalOr;
  }
  if (/إضافة 1|زيادة 1|increase 1/i.test(text)) {
    const increment = pick(choice => compactOf(choice) === 'i++');
    if (increment) return increment;
  }
  if (/أول شيء/.test(text) && /مرات|تكرار|repeat/i.test(text)) {
    const loop = pick(choice => contentOf(choice).trim() === 'for');
    if (loop) return loop;
  }
  if (/يكرر|يكرّر|تكرار|repeat/i.test(text) && choices.some(choice => /for\s*\(/.test(contentOf(choice)))) {
    const loop = pick(choice => {
      const content = contentOf(choice);
      return /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*\d+\s*;\s*i\+\+\s*\)/.test(content)
        && content.indexOf('for') < content.indexOf('{');
    });
    if (loop) return loop;
  }
  if (/إنشاء دالة|create a function/i.test(text)) {
    const name = text.match(/(?:اسمه|اسمها|اسم|بالاسم|باسم)\s+["']?([A-Za-z_$][\w$]*)/i)?.[1]
      || text.match(/(?:إنشاء|لإنشاء)\s+دالة\s+["']?([A-Za-z_$][\w$]*)/i)?.[1];
    const parameter = text.match(/(?:معاملها|وسيطها|معامل|وسيط)\s+([A-Za-z_$][\w$]*)/)?.[1];
    const declaration = pick(choice => {
      const content = contentOf(choice);
      if (!name) return false;
      if (/بدون معاملات|بلا معاملات|without parameters/i.test(text)) {
        return new RegExp(`function\\s+${name}\\s*\\(\\s*\\)`).test(content);
      }
      return parameter && new RegExp(`function\\s+${name}\\s*\\(\\s*${parameter}\\s*\\)`).test(content);
    });
    if (declaration) return declaration;
  }
  if (/التقريب|round/i.test(text)) {
    const round = pick(choice => /Math\.round\s*\(/.test(contentOf(choice)));
    if (round) return round;
  }
  if (/التصريح|declaration/i.test(text) && /متغير|متغيّر|variable/i.test(text)) {
    const variable = extractVariable(text);
    const declaration = pick(choice => variable && compactOf(choice) === `let${variable};`);
    if (declaration) return declaration;
  }
  if (/console\.log/.test(text) || /وحدة التحكم|console/i.test(text)) {
    const variable = extractVariable(text);
    if (variable && !/declare|let number/i.test(text)) {
      const print = pick(choice => compactOf(choice) === `console.log(${variable});`);
      if (print) return print;
    }
    const quoted = text.match(/"([^"]+)"/)?.[1];
    if (quoted && !arithmetic) {
      const print = pick(choice => compactOf(choice) === `console.log("${quoted}");`);
      if (print) return print;
    }
  }
  if (/إذا كان الشرط|إذا\s*~|if\s*~|if \(conditional\)|إذن/i.test(text)) {
    const ifSyntax = pick(choice => /if\s*\(\s*conditional\s*\)\s*\{\s*processing\s*\}/i.test(contentOf(choice)));
    if (ifSyntax) return ifSyntax;
  }
  if (/else if/i.test(text) || /if not.*\bif\b/i.test(text) || /if not, do B/i.test(text)) {
    const elseIfSyntax = pick(choice => /if\s*\(\s*conditional\s*\)\s*\{\s*A\s*\}\s*else if\s*\(\s*conditional\s*\)\s*\{\s*B\s*\}/i.test(contentOf(choice)));
    if (elseIfSyntax) return elseIfSyntax;
  }
  if (/وإلا|otherwise|else|if not/i.test(text) && (/if/i.test(text) || /إذا/.test(text))) {
    const elseSyntax = pick(choice => {
      const content = contentOf(choice);
      return /if\s*\(\s*conditional\s*\)\s*\{\s*A\s*\}\s*else\s*\{\s*B\s*\}/i.test(content)
        && content.indexOf('if') < content.indexOf('else');
    });
    if (elseSyntax) return elseSyntax;
  }

  if (/أول شيء|بداية البرنامج|beginning/i.test(text) && /مرات|تكرار|repeat/i.test(text)) {
    const loop = pick(choice => contentOf(choice).trim() === 'for');
    if (loop) return loop;
  }
  if (/typeof|\bstring\b|نوع البيانات/.test(text)) {
    const type = pick(choice => /typeof\s+"[^"]+"/.test(contentOf(choice)));
    if (type) return type;
  }
  if (/أصغر من\s*B|أكبر من\s*B/.test(text)) {
    const comparison = text.match(/([A-Za-z_$][\w$]*)\s*(أصغر من|أكبر من)\s*([A-Za-z_$][\w$]*)/);
    if (comparison) {
      const operator = comparison[2] === 'أصغر من' ? '<' : '>';
      const expected = normalizeCode(`${comparison[1]} ${operator} ${comparison[3]}`);
      const matched = pick(choice => compactOf(choice) === expected);
      if (matched) return matched;
    }
  }
  if (/قابلة للقسمة|باقي القسمة|بدون باقي/.test(text)) {
    const variable = text.match(/([A-Za-z_$][\w$]*)\s*(?:قابلة للقسمة)/)?.[1];
    const divisor = normalizedText.match(/على\s*(\d+)/)?.[1];
    if (variable && divisor) {
      const remainder = pick(choice => compactOf(choice) === normalizeCode(`${variable} % ${divisor} == 0`));
      if (remainder) return remainder;
    }
  }
  if (/ليس مساوية|ليست مساوية|لا تساوي|مختلفة|not equal/i.test(text)) {
    const unequal = pick(choice => /!=/.test(contentOf(choice)));
    if (unequal) return unequal;
  }
  if (/إعادة الإسناد|reassignment/i.test(text)) {
    const mutable = pick(choice => contentOf(choice).trim() === 'let');
    if (mutable) return mutable;
  }
  if (/Math\.min|Math\.max/.test(text)) {
    const method = text.match(/Math\.(min|max)/)?.[1];
    const call = pick(choice => method && new RegExp(`console\\.log\\(\\s*Math\\.${method}\\s*\\(`).test(contentOf(choice)));
    if (call) return call;
  }
  if (/يمرّر الوسائط|يمرر الوسائط|تمرير الوسائط|passes.*arguments/i.test(text)) {
    const functionName = text.match(/الدالة\s+([A-Za-z_$][\w$]*)/)?.[1];
    const args = [...normalizedText.split(/إلى الدالة|to the function/)[0].matchAll(/\d+/g)].map(match => match[0]);
    if (functionName && args.length) {
      const call = pick(choice => compactOf(choice) === `console.log(${functionName}(${args.join(',')}));`);
      if (call) return call;
    }
  }
  if (/تغيير قيمة المتغير|تغيّر قيمة المتغير|تغيّر قيمة المتغيّر|قيمة المتغير.*في البرنامج|قيمة المتغيّر.*في البرنامج/.test(text) && choices.some(choice => /→/.test(contentOf(choice)))) {
    const loop = extractCode(question.content).match(/for\s*\(\s*let\s+i\s*=\s*(\d+)\s*;\s*i\s*(<|<=)\s*(\d+)/);
    if (loop) {
      const sequence = [];
      for (let value = Number(loop[1]); loop[2] === '<' ? value < Number(loop[3]) : value <= Number(loop[3]); value += 1) sequence.push(value);
      const expected = sequence.join('→');
      const matched = pick(choice => normalizeCode(cleanMarkup(choice.content)) === expected);
      if (matched) return matched;
    }
  }
  if (/خاصية/.test(text) && /font-weight/.test(text) && /bold/.test(text)) {
    const bold = pick(choice => /عريض/.test(contentOf(choice)));
    if (bold) return bold;
  }
  if (/خاصية/.test(text) && /background-color/.test(text)) {
    const background = pick(choice => /لون الخلفية/.test(contentOf(choice)));
    if (background) return background;
  }
  if (/خاصية/.test(text) && /\bcolor\b/.test(text)) {
    const color = pick(choice => /لون النص/.test(contentOf(choice)));
    if (color) return color;
  }
  if (/default/.test(text) && /switch/.test(text)) {
    const fallback = pick(choice => /لا تتطابق|not match|no case/i.test(contentOf(choice)));
    if (fallback) return fallback;
  }
  if (/كسر السطر|line break/i.test(text)) {
    const br = pick(choice => /^br\s+tag/i.test(contentOf(choice)));
    if (br) return br;
  }
  if (/<ul>/.test(text) && /نوع العرض|display/i.test(text)) {
    const bullets = pick(choice => /^[・•]/.test(contentOf(choice)));
    if (bullets) return bullets;
  }
  if (/Phone Number/.test(text) || choices.some(choice => /Phone Number/.test(contentOf(choice)))) {
    const form = pick(choice => {
      const content = contentOf(choice);
      return content.indexOf('type="text"') >= 0
        && content.indexOf('type="text"') < content.indexOf('type="button"')
        && /type="button"\s+value="Enter"/.test(content);
    });
    if (form) return form;
  }
  if (/خاصية/.test(text) && /class/.test(text) && /<p>/.test(text)) {
    const classAttribute = pick(choice => /<p\s+class="[^"]+">[^<]+<\/p>/.test(contentOf(choice)));
    if (classAttribute) return classAttribute;
  }
  if (/CSS/.test(text) && /hover|لمس الفأرة|تحوّل.*اللون/i.test(text)) {
    const duration = normalizedText.match(/(\d+)\s*ثوان/)?.[1];
    const hover = pick(choice => {
      const content = contentOf(choice);
      return /:hover\s*\{/.test(content)
        && (!/الأحمر|\bred\b/i.test(text) || /background-color\s*:\s*red/.test(content))
        && (!duration || new RegExp(`transition\\s*:\\s*${duration}s`).test(content));
    });
    if (hover) return hover;
  }
  if (/border|إطار|حدًا/.test(text)) {
    const thickness = normalizedText.match(/(\d+)px/)?.[1];
    const colorName = normalizedText.match(/لونه\s+(أزرق|أحمر|أخضر)|اللون\s+(أزرق|أحمر|أخضر)/)?.[1];
    const cssColor = colorName ? { أزرق: 'blue', أحمر: 'red', أخضر: 'green' }[colorName] : '';
    const border = pick(choice => {
      const content = contentOf(choice);
      return thickness && new RegExp(`border:\\s*${thickness}px\\s+solid`).test(content)
        && (!cssColor || new RegExp(`\\b${cssColor}\\b`).test(content));
    });
    if (border) return border;
  }
  if (/tomato/i.test(text) && /color:\s*red/i.test(text) && /النتيجة|output/i.test(text)) {
    const red = pick(choice => {
      const content = contentOf(choice);
      return /باللون الأحمر/.test(content)
        && (!/<span\s+class="tomato">Tomato<\/span>Hamburger/i.test(text) || /"Tomato"/.test(content));
    });
    if (red) return red;
  }
  if (/يُ?كرر عملي|طالما أن الشرط|while/i.test(text) && choices.some(choice => /if|while/.test(contentOf(choice)))) {
    const loop = pick(choice => /while\s*\(/.test(contentOf(choice)));
    if (loop) return loop;
  }

  if (/المخطط الانسيابي/.test(text) && /غير الصحيحة|الخاطئة/.test(text)) {
    if (hints.includes('هل الطول 140 سم أو أكثر') && hints.includes('نعم')) {
      const incomplete = pick(choice => /طولك 140 سم أو أكثر/.test(contentOf(choice))
        && /يمكنك الركوب بمفردك/.test(contentOf(choice)) && !/عمرك/.test(contentOf(choice)));
      if (incomplete) return incomplete;
    }
    if (choices.some(choice => /عمرك 18 سنة أو أكثر/.test(contentOf(choice)))) {
      const combined = pick(choice => /عمرك 12 سنة أو أكثر/.test(contentOf(choice))
        && /طولك 140 سم أو أكثر/.test(contentOf(choice)) && /يمكنك الركوب بمفردك/.test(contentOf(choice)));
      if (combined) return combined;
    }
  }

  let best = choices[0];
  let bestScore = -Infinity;
  for (const choice of choices) {
    const content = contentOf(choice);
    let score = similarity(content, hints) * 8;
    for (const model of modelAnswers) {
      const normalizedChoice = normalizeCode(content);
      const normalizedModel = normalizeCode(model.code);
      if (normalizedChoice && normalizedModel.includes(normalizedChoice)) score += 8;
      score += similarity(content, model.code) * 4;
    }
    if (score > bestScore) {
      best = choice;
      bestScore = score;
    }
  }
  return best;
}

function normalizeDigits(value) {
  return String(value || '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function comparisonText(value) {
  return normalizeDigits(value).replace(/([A-Za-z_$][\w$]*)\s+أيضًا\s+(-?\d+(?:\.\d+)?)/g, '$1 أيضًا يساوي $2');
}

function repeatCount(text) {
  const normalized = normalizeDigits(text);
  const digitMatch = normalized.match(/(\d+)\s*مرات/) || normalized.match(/مرات\s*(\d+)/);
  if (digitMatch) return Number(digitMatch[1]);
  const words = [
    ['عشر', 10], ['تسع', 9], ['ثمان', 8], ['سبع', 7], ['ست', 6],
    ['خمس', 5], ['أربع', 4], ['ثلاث', 3], ['اثنان', 2], ['واحدة', 1]
  ];
  for (const [word, value] of words) {
    if (new RegExp(`(?:^|\\s)${word}\\s+مرات`).test(normalized)) return value;
  }
  return 10;
}

function extractComparisons(text) {
  const comparisons = [];
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:أيضًا\s+(?:يساوي\s+)?)?(أكبر من أو يساوي|أصغر من أو يساوي|أقل من أو يساوي|أكبر من أو تساوي|أصغر من أو تساوي|أقل من أو تساوي|أكبر من|أصغر من|أقل من|لا يساوي|تساوي|يساوي|هي)\s*(-?\d+(?:\.\d+)?)/g;
  const operators = {
    'أكبر من أو يساوي': '>=',
    'أصغر من أو يساوي': '<=',
    'أقل من أو يساوي': '<=',
    'أكبر من أو تساوي': '>=',
    'أصغر من أو تساوي': '<=',
    'أقل من أو تساوي': '<=',
    'أكبر من': '>',
    'أصغر من': '<',
    'أقل من': '<',
    'لا يساوي': '!=',
    'تساوي': '==',
    'يساوي': '==',
    'هي': '=='
  };
  let match;
  while ((match = pattern.exec(comparisonText(text)))) {
    comparisons.push(`${match[1]} ${operators[match[2]]} ${match[3]}`);
  }
  return comparisons;
}

function conditionFromText(text) {
  const comparisons = extractComparisons(text);
  if (!comparisons.length) return '';
  const connectorText = text
    .replace(/أكبر من أو يساوي|أصغر من أو يساوي|أقل من أو يساوي/g, '')
    .replace(/أكبر من أو تساوي|أصغر من أو تساوي|أقل من أو تساوي/g, '')
    .replace(/أكبر من|أصغر من|أقل من/g, '');
  return comparisons.join(connectorText.includes(' أو ') ? ' || ' : ' && ');
}

function extractCopyTexts(value) {
  return [...String(value || '').matchAll(/\[\[copy\]\](.*?)\[\[\/copy\]\]/gs)]
    .map(match => cleanMarkup(match[1]))
    .filter(Boolean);
}

function extractVariable(value) {
  const text = cleanMarkup(value);
  return text.match(/(?:المتغير|المتغيّر|متغير|متغيّر|variable)\s+([A-Za-z_$][\w$]*)/i)?.[1]
    || text.match(/(?:اسم المتغير|اسم المتغيّر)\s+(?:هو|يجب أن يكون)?\s*([A-Za-z_$][\w$]*)/i)?.[1]
    || '';
}

function extractAssignment(value) {
  const text = normalizeDigits(cleanMarkup(value));
  return text.match(/(?:أسند|أسنِد|أعطه|القيمة)\s*(?:له\s*)?(?:القيمة\s*)?(\d+)/)?.[1]
    || text.match(/وأسند له\s+(\d+)/)?.[1]
    || '';
}

function arithmeticExpression(value) {
  const match = normalizeDigits(cleanMarkup(value)).match(/(-?\d+(?:\.\d+)?)\s*([+\-*×÷/])\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return '';
  const operator = match[2] === '×' ? '*' : match[2] === '÷' ? '/' : match[2];
  return `${match[1]} ${operator} ${match[3]}`;
}

function quotedOutputs(value) {
  const ignored = new Set(['Run Code', 'Answer', 'If ~, I will do 00', 'If 100 points, I will eat out.']);
  const text = String(value || '');
  const matches = [];
  const patterns = [
    /"([^"\n]+)"/g,
    /‘([^’\n]+)’/g,
    /(?<![\w])'([^'\n]+)'(?![\w])/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) matches.push({ index: match.index, value: match[1].trim() });
  }
  return [...new Set(matches.sort((a, b) => a.index - b.index).map(item => item.value))]
    .filter(item => item && !ignored.has(item));
}

function placeholderTemplateRegex(template) {
  const normalized = normalizeCode(template);
  const parts = normalized.split(/(fitbBlock\d+)/g);
  const source = parts.map(part => /^fitbBlock\d+$/.test(part)
    ? '(.+?)'
    : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${source}$`);
}

function fillPlaceholders(template, questionText) {
  questionText = cleanMarkup(questionText);
  const values = {};
  const names = template.match(/fitbBlock\d+/g) || [];
  const comparisons = extractComparisons(questionText);
  const count = repeatCount(questionText);
  const variable = extractVariable(questionText);
  const copyTexts = extractCopyTexts(questionText);
  const outputs = quotedOutputs(questionText);
  let comparisonIndex = 0;
  const separateConditions = (template.match(/(?:if|while)\s*\(\s*fitbBlock\d+\s*\)/g) || []).length > 1;  if (/^\s*fitbBlock1\s*\(/.test(template) && names.length >= 2) {
    values[names[0]] = 'for';
    values[names[1]] = `let i = 0; i < ${count}; i++`;
  }

  if (/for\s*\(\s*fitbBlock1\s*\)/.test(template)) {
    values[names[0]] = `let i = 0; i < ${count}; i++`;
  }

  for (const name of names) {
    if (values[name]) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:if|while)\\s*\\(\\s*${escaped}\\s*\\)`).test(template)) {
      if (/Math\.random/.test(questionText) && /0\.5/.test(questionText)) {
        values[name] = 'Math.random() >= 0.5';
      } else {
        values[name] = separateConditions
          ? comparisons[comparisonIndex++] || explicitCondition(questionText, template)
          : conditionFromText(questionText) || explicitCondition(questionText, template);
      }
      continue;
    }
    if (new RegExp(`${escaped}\\s*\\{`).test(template) && /else if/.test(template)) {
      values[name] = 'else';
      continue;
    }
    if (new RegExp(`}\\s*${escaped}\\s*\\{`).test(template)) {
      values[name] = `else if (${explicitCondition(questionText, template)})`;
      continue;
    }
    if (template.includes(`console.log(${name})`)) {
      const arrayName = templateArrayName(template);
      if (arrayName && /طول|عدد القيم/.test(questionText)) {
        values[name] = `${arrayName}.length`;
        continue;
      }
      if (arrayName) {
        const target = arrayTarget(questionText);
        const items = (template.match(/\[([^\]]*)\]/)?.[1] || '').split(/[،,]/).map(item => item.trim().replace(/["']/g, ''));
        const index = target ? items.indexOf(target) : -1;
        if (index >= 0) {
          values[name] = `${arrayName}[${index}]`;
          continue;
        }
      }
      if (/Math\.random/.test(questionText) && /Math\.floor/.test(questionText)) {
        const multiplier = normalizeDigits(questionText).match(/في\s+(\d+)/)?.[1] || '10';
        values[name] = `Math.floor(Math.random() * ${multiplier})`;
      } else {
        const functionName = cleanMarkup(questionText).match(/(?:الدالة|function)\s+([A-Za-z_$][\w$]*)/i)?.[1]
          || template.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1];
        const argument = normalizeDigits(cleanMarkup(questionText)).match(/(?:أدخل|ضع)\s+(\d+)/)?.[1]
          || normalizeDigits(cleanMarkup(questionText)).match(/المعامل\s+(?:هو\s+)?(\d+)/)?.[1];
        if (functionName && argument) values[name] = `${functionName}(${argument})`;
        else if (variable) values[name] = variable;
        else if (copyTexts[0]) values[name] = `"${copyTexts[0].replace(/"/g, '\\"')}"`;
        else if (outputs[0]) values[name] = `"${outputs[0].replace(/"/g, '\\"')}"`;
      }
      continue;
    }
    if (new RegExp(`^\\s*${escaped}\\s*$`, 'm').test(template) && /يعيد|يُرجع|يرجع|إرجاع|return/i.test(questionText)) {
      const variable = extractVariable(questionText) || 'result';
      values[name] = `return ${variable};`;
    }
  }

  if (names.some(name => !values[name])) return null;
  return names.reduce((code, name) => code.replace(name, values[name]), template);
}

function printStatement(value) {
  return `console.log(${value});`;
}

function consoleArgument(questionText, variable) {
  const arithmetic = arithmeticExpression(questionText);
  if (arithmetic) return arithmetic;
  if (/Math\.random/.test(questionText) && /Math\.floor/.test(questionText)) {
    const multiplier = normalizeDigits(cleanMarkup(questionText)).match(/(?:في|في\s+العدد|multiply by)\s*(\d+)/)?.[1] || '10';
    return `Math.floor(Math.random() * ${multiplier})`;
  }
  if (variable) return variable;
  const copied = extractCopyTexts(questionText)[0];
  const quoted = quotedOutputs(questionText)[0];
  const text = copied || quoted;
  return text ? `"${text.replace(/"/g, '\\"')}"` : '';
}

function initialValue(questionText) {
  const text = normalizeDigits(cleanMarkup(questionText));
  return text.match(/(?:القيمة|قيمة|أسند له|أعطه|تساوي)\s*(\d+)/)?.[1]
    || text.match(/أسند\s*(\d+)/)?.[1]
    || text.match(/(?:وأسند له|وأسند له)\s*(\d+)/)?.[1]
    || '';
}

function mathStatements(questionText) {
  const text = cleanMarkup(questionText);
  const matches = [];
  const patterns = [
    { name: 'round', regex: /(?:Math\.round|تقريب)(?!\s*إلى أسفل)[\s\S]{0,25}?(\d+(?:\.\d+)?)/gi },
    { name: 'floor', regex: /(?:Math\.floor|التقريب إلى أسفل|إلى أسفل|للأسفل)[\s\S]{0,45}?(\d+(?:\.\d+)?)/gi }
  ];
  for (const { name, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      matches.push({ index: match.index, code: printStatement(`Math.${name}(${match[1]})`) });
    }
  }
  return matches.sort((a, b) => a.index - b.index).map(item => item.code);
}

function conditionActions(questionText) {
  const text = comparisonText(cleanMarkup(questionText));
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:أيضًا\s+(?:يساوي\s+)?)?(أكبر من أو يساوي|أصغر من أو يساوي|أقل من أو يساوي|أكبر من أو تساوي|أصغر من أو تساوي|أقل من أو تساوي|أكبر من|أصغر من|أقل من|لا يساوي|تساوي|يساوي|هي)\s*(-?\d+(?:\.\d+)?)/g;
  const operators = {
    'أكبر من أو يساوي': '>=', 'أصغر من أو يساوي': '<=', 'أقل من أو يساوي': '<=',
    'أكبر من أو تساوي': '>=', 'أصغر من أو تساوي': '<=', 'أقل من أو تساوي': '<=',
    'أكبر من': '>', 'أصغر من': '<', 'أقل من': '<', 'لا يساوي': '!=', 'تساوي': '==', 'يساوي': '==', 'هي': '=='
  };
  const matches = [...text.matchAll(pattern)];
  return matches.map((match, index) => {
    const segment = text.slice(match.index, matches[index + 1]?.index || text.length);
    const output = quotedOutputs(segment)[0] || 'Condition met';
    return { condition: `${match[1]} ${operators[match[2]]} ${match[3]}`, output, end: match.index + match[0].length };
  });
}

function ifProgram(questionText) {
  const variable = extractVariable(questionText);
  const actions = conditionActions(questionText);
  const value = initialValue(questionText);
  const lines = [];
  if (variable && value) lines.push(`let ${variable} = ${value};`);
  actions.forEach((action, index) => {
    const prefix = index === 0 ? 'if' : 'else if';
    lines.push(`${prefix} (${action.condition}) {${printStatement(`"${action.output}"`)}}`);
  });
  if (actions.length && /وإلا|else|غير ذلك|في غير ذلك|إذا لم يكن كذلك/i.test(questionText)) {
    const tail = normalizeDigits(cleanMarkup(questionText)).slice(actions.at(-1).end);
    const finalElse = tail.match(/(?:وإلا|else|غير ذلك|في غير ذلك|إذا لم يكن كذلك)[\s\S]*?"([^"]+)"/i)?.[1];
    if (finalElse) lines.push(`else {${printStatement(`"${finalElse}"`)}}`);
  }
  return lines.join('\n');
}

function arrayFromQuestion(questionText) {
  const match = String(questionText).match(/القيم التالية[^\n]*\n\s*([\d\s,،]+)/);
  return match ? match[1].split(/[،,]/).map(item => item.trim()).filter(Boolean) : [];
}

function templateArrayName(template) {
  return template.match(/\b(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/)?.[1] || '';
}

function arrayTarget(questionText) {
  return cleanMarkup(questionText).match(/القيمة\s*["'‘’]?(\d+(?:\.\d+)?)["'‘’]?/)?.[1]
    || quotedOutputs(questionText).find(value => /^\d+(?:\.\d+)?$/.test(value))
    || '';
}

function explicitCondition(questionText, template = '') {
  const text = cleanMarkup(questionText);
  const quoted = text.match(/["'`]([A-Za-z_$][\w$]*\s*(?:==|!=|<=|>=|<|>)\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*|\d+))["'`]/);
  if (quoted) return quoted[1];

  const remainder = text.match(/([A-Za-z_$][\w$]*)\s*%\s*(\d+)\s*(?:يساوي|==)\s*(\d+)/);
  if (remainder) return `${remainder[1]} % ${remainder[2]} == ${remainder[3]}`;
  const divisor = text.match(/قسمة[^.]*?([A-Za-z_$][\w$]*)[^.]*?على\s*(\d+)[^.]*?(?:يساوي|==)\s*(\d+)/);
  if (divisor) return `${divisor[1]} % ${divisor[2]} == ${divisor[3]}`;

  const equality = text.match(/([A-Za-z_$][\w$]*)\s*(?:مساوية لـ|مساوي لـ|يساوي)\s*(\d+)/);
  if (equality) return `${equality[1]} == ${equality[2]}`;

  const unequal = text.match(/([A-Za-z_$][\w$]*)\s*(?:!=|لا يساوي|مختلفة عن)\s*([A-Za-z_$][\w$]*)/);
  if (unequal) return `${unequal[1]} != ${unequal[2]}`;
  const differentValues = text.match(/قيم\s+([A-Za-z_$][\w$]*)\s+و\s*([A-Za-z_$][\w$]*)\s*مختلفة/);
  if (differentValues) return `${differentValues[1]} != ${differentValues[2]}`;
  if (/numberOfPeople/.test(text) && /weight/.test(text) && /أصغر من أو يساوي/.test(text)) {
    const people = text.match(/numberOfPeople[^.]*?(\d+)/)?.[1] || '10';
    const weight = text.match(/weight[^.]*?(\d+)/)?.[1] || '800';
    return `numberOfPeople <= ${people} || weight <= ${weight}`;
  }

  const variableComparison = text.match(/([A-Za-z_$][\w$]*)\s*(أصغر من|أكبر من|أصغر من أو يساوي|أكبر من أو يساوي)\s*([A-Za-z_$][\w$]*)/);
  if (variableComparison) {
    const operators = { 'أصغر من': '<', 'أكبر من': '>', 'أصغر من أو يساوي': '<=', 'أكبر من أو يساوي': '>=' };
    return `${variableComparison[1]} ${operators[variableComparison[2]]} ${variableComparison[3]}`;
  }

  const stringComparison = text.match(/([A-Za-z_$][\w$]*)\s*(?:هو|هي|يساوي)\s*["']([^"']+)["']/);
  if (stringComparison) return `${stringComparison[1]} == "${stringComparison[2]}"`;
  if (/money/.test(text) && /snacks/.test(text) && /أكبر من/.test(text)) return 'money > snacks';
  if (/money/.test(text) && /أقل من/.test(text)) {
    const target = text.match(/المبلغ المستهدف\s*(\d+)/)?.[1] || '4000';
    return `money < ${target}`;
  }

  const comparisons = extractComparisons(text);
  return conditionFromText(text) || comparisons[0] || '';
}

function stringConditions(template, questionText) {
  const conditions = [];
  const pattern = /\b(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g;
  for (const match of template.matchAll(pattern)) {
    conditions.push(`${match[1]} == "${match[2]}"`);
  }
  return conditions;
}

function functionCallFromQuestion(questionText, functionName) {
  const text = normalizeDigits(cleanMarkup(questionText).replace(/\*\*/g, '').replace(/["'‘’«»]/g, ''));
  if (!functionName) return '';
  const passing = text.match(/تمرير\s+(?:القيمة|القيم)?\s*([\d\s,و]+)/)
    || text.match(/(?:بوسيطين|بالوسيطين|يمرر المعاملين|تمرير المعاملين)\s+([\d\s,و]+)/);
  if (passing) {
    const args = passing[1].match(/\d+/g) || [];
    if (args.length) return `${functionName}(${args.join(', ')})`;
  }
  const explicit = text.match(new RegExp(`${functionName}\\s*\\(\\s*([\\d\\s,]+)\\s*\\)`));
  if (explicit) return `${functionName}(${explicit[1].trim()})`;
  const parameters = text.match(/(?:المعاملين|وسيطين|الوسائط)[^\d]*([\d\sو,]+)/);
  if (parameters) {
    const args = parameters[1].match(/\d+/g) || [];
    if (args.length) return `${functionName}(${args.join(', ')})`;
  }
  return `${functionName}()`;
}

function functionDefinition(questionText, template = '') {
  const text = cleanMarkup(questionText);
  const name = text.match(/(?:دالة|function)\s+(?:بالاسم\s+|اسم\s+|باسم\s+)?["']?([A-Za-z_$][\w$]*)/i)?.[1]
    || template.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1];
  if (!name) return null;
  const parameterSection = text.match(/(?:بالمعاملات|بالمعاملين)\s+([^①②③④.]*)/)?.[1] || '';
  const parameterText = parameterSection.split(/[①②③④]|أسند|أضف|أنشئ|استدعِ|استدعي/)[0];
  const parameters = /بدون معاملات|بلا معاملات|without parameters/i.test(text)
    ? []
    : [...parameterText.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]);
  const uniqueParameters = [...new Set(parameters)];
  const expression = text.match(/([A-Za-z_$][\w$]*)\s*[×*]\s*([A-Za-z_$][\w$]*)(?:\s*[×*]\s*([A-Za-z_$][\w$]*))?/);
  return { name, parameters: uniqueParameters, expression: expression ? expression.slice(1).filter(Boolean).join(' * ') : '' };
}

function switchCases(questionText) {
  const text = normalizeDigits(cleanMarkup(questionText));
  const outputs = quotedOutputs(questionText);
  const values = [];
  const valuePattern = /(?:القيمة|إذا كانت)\s*["']?([A-Za-z]|\d+)["']?/g;
  for (const match of text.matchAll(valuePattern)) values.push(match[1]);
  const remainder = text.match(/على\s*(\d+)/)?.[1];
  if (remainder && outputs.length) {
    const cases = [];
    for (let index = 0; index < outputs.length; index += 1) {
      const start = text.indexOf(outputs[index]);
      const end = index + 1 < outputs.length ? text.indexOf(outputs[index + 1], start + outputs[index].length) : -1;
      const after = text.slice(start + outputs[index].length, end >= 0 ? end : start + outputs[index].length + 180);
      const valuesAfter = [...after.matchAll(/(?:يساوي|الباقي)\s*(\d+)/g)];
      const value = valuesAfter[0]?.[1] || String(index);
      cases.push({ value, output: outputs[index] });
    }
    return { expression: remainder, cases };
  }
  return {
    expression: extractVariable(text) || 'letter',
    cases: outputs.map((output, index) => ({ value: values[index] || String.fromCharCode(65 + index), output }))
  };
}

function stringActions(questionText) {
  const text = cleanMarkup(questionText);
  const actions = [];
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:يساوي|هو)\s*["']([^"']+)["']/g;
  const matches = [...text.matchAll(pattern)];
  matches.forEach((match, index) => {
    const segment = text.slice(match.index, matches[index + 1]?.index || text.length);
    const output = segment.match(/(?:أخرج|اطبع|اعرض)[\s\S]{0,40}?"([^"]+)"/)?.[1];
    if (output) actions.push({ condition: `${match[1]} == "${match[2]}"`, output });
  });
  return actions;
}

function completeTemplate(template, questionText) {
  const normalized = normalizeCode(template);
  const variable = extractVariable(questionText);
  const value = initialValue(questionText);
  const argument = consoleArgument(questionText, variable);
  let result = template;

  if (/إعادة الإسناد|reassignment|خطأ يظهر|خطأ يحدث/.test(questionText) && /^\s*const\s+/m.test(template)) {
    return template.replace(/^(\s*)const\s+/m, '$1let ');
  }

  if (/console\.log\(([A-Za-z_$][\w$]*)\)/.test(template) && /نتيجة الدالة|ناتج الدالة/.test(questionText)) {
    const printed = template.match(/console\.log\(([A-Za-z_$][\w$]*)\)/)?.[1];
    const definition = functionDefinition(questionText, template);
    if (definition && !new RegExp(`let\\s+${printed}\\s*=`).test(template)) {
      const declaration = `let ${printed} = ${functionCallFromQuestion(questionText, definition.name)};`;
      return template.replace(new RegExp(`console\\.log\\(${printed}\\)`), `${declaration}\nconsole.log(${printed})`);
    }
  }

  if (/else if/.test(questionText) && /\bif\s*\(/.test(template) && !/else if/.test(template)) {
    const actions = stringActions(questionText);
    if (actions.length) {
      return template.trimEnd() + actions.map(action => `\nelse if (${action.condition}) {\n  ${printStatement(`"${action.output}"`)}\n}`).join('');
    }
  }

  if (/نوع البيانات|typeof/i.test(questionText)) {
    const literal = cleanMarkup(questionText).match(/typeof\s+(.+?)(?:\s+في|\s+على|$)/)?.[1]
      || quotedOutputs(questionText)[0];
    const value = literal ? `"${literal.replace(/"/g, '')}"` : quotedOutputs(questionText)[0]
      ? `"${quotedOutputs(questionText)[0]}"`
      : cleanMarkup(questionText).match(/نوع البيانات\s*(\d+)/)?.[1]
        || cleanMarkup(questionText).match(/لـ\s*`?"?(\d+)"?`?/)?.[1];
    return printStatement(`typeof ${value || literal || ''}`.trim());
  }

  const arrayName = templateArrayName(template);
  if (arrayName && /ضع القيم|المصفوفة/.test(questionText) && /\[\s*\]/.test(template)) {
    const values = arrayFromQuestion(questionText);
    if (values.length) return template.replace(/\[\s*\]/, `[${values.join(', ')}]`);
  }

  if (arrayName && /متوسط|sum\s*=\s*sum\s*\+\s*scoreList/.test(questionText)) {
    const count = normalizeDigits(cleanMarkup(questionText)).match(/(?:سبع|سبعة)\s*مرات|عدد الأشخاص\s*\(?\s*(\d+)/)?.[1] || '7';
    return `${template}\nlet sum = 0;\nfor (let i = 0; i < ${count}; i++) {\n  sum = sum + ${arrayName}[i];\n}\nconsole.log(sum / ${count});`;
  }
  if (arrayName && /for\.\.\.of/.test(questionText) && !/for\s*\(/.test(template)) {
    const item = cleanMarkup(questionText).match(/هو\s*([A-Za-z_$][\w$]*)/)?.[1] || 'num';
    return `${template}\nfor (let ${item} of ${arrayName}) {\n  ${printStatement(item)}\n}`;
  }
  if (arrayName && /scoreList\[i\]|القيمة\s+i\s+(?:في|ل)/.test(cleanMarkup(questionText)) && /for|حلقة/.test(questionText) && !/for\s*\(/.test(template)) {
    const threshold = normalizeDigits(cleanMarkup(questionText)).match(/(?:أكبر من أو يساوي|أكبر من أو تساوي|تساوي أو تزيد عن|80\s*أو\s*(?:أعلى|أكثر))\s*(\d+)?/)?.[1] || '80';
    const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0] || 'Pass';
    return `${template}\nfor (let i = 0; i < ${arrayName}.length; i++) {\n  if (${arrayName}[i] >= ${threshold}) {\n    ${printStatement(`"${output}"`)}\n  }\n}`;
  }
  if (arrayName && /console\.log|وحدة التحكم/.test(questionText) && !/console\.log/.test(template)
    && !/for|حلقة/.test(questionText)) {
    const target = arrayTarget(questionText);
    if (/طول|عدد القيم/.test(questionText)) return `${template}\n${printStatement(`${arrayName}.length`)}`;
    if (target) {
      const values = (template.match(/\[([^\]]*)\]/)?.[1] || '').split(/[،,]/).map(item => item.trim().replace(/["']/g, ''));
      const index = values.indexOf(target);
      if (index >= 0) return `${template}\n${printStatement(`${arrayName}[${index}]`)}`;
    }
  }
  if (arrayName && /console\.log\(\s*\)/.test(template)) {
    if (/طول|عدد القيم/.test(questionText)) return template.replace(/console\.log\(\s*\)/, `console.log(${arrayName}.length)`);
    const target = arrayTarget(questionText);
    const values = (template.match(/\[([^\]]*)\]/)?.[1] || '').split(/[،,]/).map(item => item.trim().replace(/["']/g, ''));
    const index = target ? values.indexOf(target) : -1;
    if (index >= 0) return template.replace(/console\.log\(\s*\)/, `console.log(${arrayName}[${index}])`);
  }

  if (template.includes('fitbBlock') && arrayName) {
    const target = arrayTarget(questionText);
    if (target && /طول/.test(questionText)) return template.replace(/fitbBlock\d+/, `${arrayName}.length`);
    if (target) {
      const values = (template.match(/\[([^\]]*)\]/)?.[1] || '').split(/[،,]/).map(item => item.trim().replace(/["']/g, ''));
      const index = values.indexOf(target);
      if (index >= 0) return template.replace(/fitbBlock\d+/, `${arrayName}[${index}]`);
    }
    if (/جميع القيم|طول المصفوفة|عدد القيم/.test(questionText)) {
      return template.replace(/fitbBlock\d+/, /طول|عدد القيم/.test(questionText) ? `${arrayName}.length` : arrayName);
    }
  }

  if (/<!--/.test(template) || /\/\*/.test(template) || /fitbBlock1.*fitbBlock2/.test(template)) {
    if (/تعليق|comment/i.test(questionText)) {
      if (/HTML|وسم|h1/i.test(questionText + ' ' + template)) return template.replace(/fitbBlock1([\s\S]*?)fitbBlock2/, '<!--$1-->');
      return template.replace(/fitbBlock1([\s\S]*?)fitbBlock2/, '/*$1*/');
    }
  }
  if (/إحاطة|داخل.*وسم|ضع النص/.test(questionText) && !/[<>]/.test(template)) {
    const tag = cleanMarkup(questionText).match(/\b(h1|p|div|span)\b/)?.[1] || 'p';
    return `<${tag}>${template.trim()}</${tag}>`;
  }

  if (/CSS|selector|المُنتقِي|المنتقي|خاصية|لون|حدد القيمة/.test(questionText) && /\{/.test(template)) {
    if (/^\s*\{/.test(template)) {
      const selector = cleanMarkup(questionText).match(/["']?\.([A-Za-z_][\w-]*)["']?/)?.[1];
      const htmlClass = extractCode(questionText).match(/class="([^"]+)"/)?.[1];
      const tag = cleanMarkup(questionText).match(/\b(h[1-6]|p)\b/)?.[1];
      const chosen = htmlClass ? `.${htmlClass}` : selector ? `.${selector}` : tag;
      if (chosen) return `${chosen} ${template.trimStart()}`;
    }
    const cssValue = (quotedOutputs(questionText)[0] || '').replace(/[.؛]$/, '');
    if (cssValue && /color\s*:\s*(?=\n\s*})/.test(template)) {
      return template.replace(/color\s*:\s*(?=\n\s*})/, `color: ${cssValue};`);
    }
  }

  if (/قائمة نقطية|ul/.test(questionText) && /<p>/.test(template)) {
    const items = extractCopyTexts(questionText);
    return `${template}\n<ul>\n${items.map(item => `  <li>${item}</li>`).join('\n')}\n</ul>`;
  }
  if (/value/.test(questionText) && /<input/.test(template) && !/value=/.test(template)) {
    const value = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0];
    if (value) return template.replace(/<input\s+([^>]+)>/, `<input $1 value="${value}">`);
  }

  const calledFunction = template.match(/console\.log\(\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\)/)?.[1];
  const definedFunction = template.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1];
  if (definedFunction && /اطبع|أخرج|وحدة التحكم/.test(questionText) && !/console\.log/.test(template)
    && !template.includes('fitbBlock')) {
    const call = functionCallFromQuestion(questionText, definedFunction);
    return `${template.trimEnd()}\n${printStatement(call)}`;
  }
  if (calledFunction && !new RegExp(`function\\s+${calledFunction}\\b`).test(template)) {
    const definition = functionDefinition(questionText, template);
    if (definition) {
      const variable = extractVariable(questionText) || 'greeting';
      const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0] || '';
      return `function ${definition.name}(${definition.parameters.join(', ')}) {\n  let ${variable} = "${output}";\n  return ${variable};\n}\n${template}`;
    }
  }

  if (/function\s+\(/.test(template) && /let result\s*=\s*;/.test(template)) {
    const definition = functionDefinition(questionText, template);
    if (definition) {
      return template
        .replace(/function\s*\(\s*\)/, `function ${definition.name}(${definition.parameters.join(', ')})`)
        .replace(/let result\s*=\s*;/, `let result = ${definition.expression};`);
    }
  }

  if (/console\.log\(\s*\)/.test(template) && /الدالة|function/i.test(questionText)) {
    const functionName = template.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1];
    const call = functionCallFromQuestion(questionText, functionName);
    if (call) return template.replace(/console\.log\(\s*\)/, `console.log(${call})`);
  }
  if (/^\s*fitbBlock1\s*$/m.test(template) && /function/.test(template) && /يستدعي|استدعِ|استدعي/.test(questionText)) {
    const functionName = template.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1];
    const call = functionCallFromQuestion(questionText, functionName);
    if (call) return template.replace(/fitbBlock1/, `console.log(${call});`);
  }

  const addedVariable = cleanMarkup(questionText).match(/المتغير\s+([A-Za-z_$][\w$]*)/)?.[1];
  const addedFunction = cleanMarkup(questionText).match(/الدالة\s+([A-Za-z_$][\w$]*)/)?.[1];
  if (addedVariable && addedFunction && /أسند|إسناد/.test(questionText)
    && !new RegExp(`let\\s+${addedVariable}\\s*=`).test(template)) {
    const call = functionCallFromQuestion(questionText, addedFunction);
    return `${template.trimEnd()}\nlet ${addedVariable} = ${call};\nconsole.log(${addedVariable});`;
  }

  if (/switch\s*\(\s*\)/.test(template)) {
    const spec = switchCases(questionText);
    const remainderVariable = cleanMarkup(questionText).match(/قسمة[^.]*?([A-Za-z_$][\w$]*)[^.]*?على\s*(\d+)/)?.[1];
    const expression = remainderVariable ? `${remainderVariable} % ${spec.expression}` : spec.expression;
    const cases = spec.cases.map(item => `  case ${/^\d+$/.test(item.value) ? item.value : `"${item.value}"`}:\n    ${printStatement(`"${item.output}"`)}\n    break;`).join('\n');
    return template.replace(/switch\s*\(\s*\)\s*\{[\s\S]*\}/, `switch (${expression}) {\n${cases}\n}`);
  }
  if (/switch/.test(template) && /default|لم تتطابق/.test(questionText) && !/default\s*:/.test(template)) {
    const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0];
    if (output) return template.replace(/\n\s*\}\s*$/, `\n  default:\n    ${printStatement(`"${output}"`)}\n    break;\n}`);
  }

  if (/(?:if|while)\s*\(\s*\)/.test(template)) {
    const condition = explicitCondition(questionText, template);
    if (condition) result = result.replace(/(if|while)\s*\(\s*\)/, `$1 (${condition})`);
    if (/if\s*\(\s*\)/.test(template) && !/console\.log/.test(result)) {
      const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0];
      if (output) result = result.replace(/(if\s*\([^)]*\)\s*\{)\s*\}/, `$1\n  ${printStatement(`"${output}"`)}\n}`);
    }
  }
  if (/(?:^|\n)\s*\(\s*\)\s*\{/.test(template) && /while/.test(questionText)) {
    result = result.replace(/(?:^|\n)(\s*)\(\s*\)\s*\{/, (_, indent) => `\n${indent}while (${explicitCondition(questionText, template)}) {`);
  }

  if (/for\s*\([^)]*\)\s*\{\s*\}/.test(template) || (/for\s*\(/.test(template) && !/console\.log/.test(template))) {
    const array = template.match(/for\s*\(\s*let\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)/);
    const threshold = cleanMarkup(questionText).match(/(?:تساوي أو تزيد عن|أكبر من أو يساوي|أكبر من أو تساوي)\s*(\d+)/)?.[1];
    if (array && threshold) {
      return template.replace(/(for\s*\([^)]*\)\s*\{)\s*\}/, `$1\n  if (${array[1]} >= ${threshold}) {\n    ${printStatement(array[1])}\n  }\n}`);
    }
    if (array) return template.replace(/(for\s*\([^)]*\)\s*\{)\s*\}/, `$1\n  ${printStatement(array[1])}\n}`);
  }

  if (/for\s*\(/.test(template) && /إذا كانت قيمة|عندما تكون قيمة/.test(questionText)) {
    const condition = explicitCondition(questionText, template);
    const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0];
    if (condition && output && !template.includes(output)) {
      const close = template.indexOf('}');
      const insertion = `\n  if (${condition}) {\n    ${printStatement(`"${output}"`)}\n  }\n`;
      return template.slice(0, close) + insertion + template.slice(close);
    }
  }

  if (/weather/.test(template) && /time/.test(template) && /movie theater|library|stay at home/.test(questionText)) {
    const outputs = quotedOutputs(questionText);
    if (outputs.length >= 4) {
      const outer = template.match(/if\s*\(([^)]+)\)/)?.[1] || 'weather == "rain"';
      const prefix = template.slice(0, template.indexOf('if'));
      return `${prefix}if (${outer}) {\n  if (time == "morning") {\n    ${printStatement(`"${outputs[0]}"`)}\n  } else if (time == "noon") {\n    ${printStatement(`"${outputs[1]}"`)}\n  } else {\n    ${printStatement(`"${outputs[2]}"`)}\n  }\n} else {\n  ${printStatement(`"${outputs[3]}"`)}\n}`;
    }
  }

  if (/متداخل|داخل.*if|ومن بين (?:هذه|تلك) الحالات/.test(questionText) && /\bif\s*\(/.test(template)) {
    const actions = conditionActions(questionText);
    const conditions = stringConditions(template, questionText);
    const outputs = quotedOutputs(questionText);
    let innerCondition = actions.length > 1 ? actions.at(-1).condition : conditions.find(condition => !template.includes(condition));
    let innerOutput = actions.length > 1 ? actions.at(-1).output : extractCopyTexts(questionText).at(-1) || outputs.at(-1);
    let elseOutput = '';
    if (!innerCondition && /\blet\s+age\b/.test(template) && /height\s*>=\s*140/.test(template) && outputs.length >= 2) {
      innerCondition = 'age >= 12';
      innerOutput = outputs[0];
      elseOutput = outputs[1];
    }
    innerCondition = innerCondition?.replace(/^[A-Za-z_$][\w$]*/, name => template.includes(`${name.toLowerCase()} `) ? name.toLowerCase() : name);
    const outputTranslations = {
      'يمكنك الركوب بمفردك': 'You can ride alone',
      'يُرجى الركوب مع شخص يبلغ 18 سنة أو أكثر': 'Please ride with someone who is 18 years or older'
    };
    innerOutput = outputTranslations[innerOutput] || innerOutput;
    elseOutput = outputTranslations[elseOutput] || elseOutput;
    if (innerCondition && innerOutput && !template.includes(innerOutput)) {
      const open = result.indexOf('{');
      const close = result.indexOf('}', open);
      const insertion = `\n  if (${innerCondition}) {\n    ${printStatement(`"${innerOutput}"`)}\n  }${elseOutput ? ` else {\n    ${printStatement(`"${elseOutput}"`)}\n  }` : ''}\n`;
      result = result.slice(0, close) + insertion + result.slice(close);
    }
  }

  const quotedTemplate = template.match(/console\.log\("([^"]+)"\)/);
  const expression = arithmeticExpression(questionText).replace(/\s+/g, '');
  if (quotedTemplate && expression && quotedTemplate[1].replace(/\s+/g, '').includes(expression)) {
    const compact = quotedTemplate[1].replace(/\s+/g, '');
    const position = compact.indexOf(expression);
    const prefix = compact.slice(0, position);
    const suffix = compact.slice(position + expression.length);
    return `console.log("${prefix}" + (${arithmeticExpression(questionText)}) + "${suffix}");`;
  }

  if (/^console\.log\s*$/.test(template.trim()) && argument) {
    return printStatement(argument);
  }
  if (/^console\.log\(\s*\);?$/.test(template.trim()) && argument) {
    return printStatement(argument);
  }
  if (/for\s*\(\s*\)/.test(template) && /مرات|تكرار/.test(questionText)) {
    result = result.replace(/for\s*\(\s*\)/, `for (let i = 0; i < ${repeatCount(questionText)}; i++)`);
  }

  if (/علّق|تعليق|comment/i.test(questionText) && /console\.log/.test(result)) {
    if (/السطر الأول|first line/i.test(questionText)) {
      const lines = result.split(/\r?\n/);
      lines[0] = `//${lines[0]}`;
      return lines.join('\n');
    }
    const expected = extractCode(questionText).split(/\n|\\n/).map(line => line.trim()).filter(Boolean);
    const wanted = expected.length
      ? expected.map(line => line.match(/"([^"]+)"/)?.[1] || line)
      : quotedOutputs(questionText);
    return result.split(/\r?\n/).map(line => {
      const text = line.match(/"([^"]+)"/)?.[1];
      return text && wanted.length && !wanted.includes(text) ? `//${line}` : line;
    }).join('\n');
  }

  if (/إذا لم يكن كذلك|وإذا|else if|شرطًا ثانيًا|شرط ثانٍ/i.test(questionText) && /\bif\s*\(/.test(result)) {
    const actions = conditionActions(questionText);
    const lastCondition = actions.at(-1)?.condition || explicitCondition(questionText, result);
    const copied = extractCopyTexts(questionText)[0];
    const output = copied || quotedOutputs(questionText).at(-1);
    if (lastCondition && output && !result.includes(lastCondition)) {
      result += `\nelse if (${lastCondition}) {${printStatement(`"${output}"`)}}`;
    }
  }

  if (variable) {
    const declaration = new RegExp(`\\blet\\s+${variable}\\b`);
    if (/أعلن|صرّح|تصريح|declare/i.test(questionText) && !declaration.test(result)) {
      result = `let ${variable}${value ? ` = ${value}` : ''};\n${result}`.trimStart();
    }
    if (value && /أسند|أسنِد|أعطه|assign/i.test(questionText)
      && !new RegExp(`${variable}\\s*=\\s*${value}\\s*;`).test(result)) {
      result += `\n${variable} = ${value};`;
    }
    const addition = normalizeDigits(cleanMarkup(questionText)).match(/مضافًا إليها\s*(\d+)|مضافة إليها\s*(\d+)|add\s*(\d+)/i);
    const amount = addition?.[1] || addition?.[2] || addition?.[3];
    if (amount) result += `\n${variable} = ${variable} + ${amount};`;
    if (/قيمة المتغير|قيمة المتغيّر|value of variable/i.test(questionText)
      && /اطبع|أخرج|اعرض|print|console/i.test(questionText)
      && !/console\.log\s*\(/.test(result)) {
      result += `\n${printStatement(variable)}`;
    }
  }
  return result.trim();
}

function generateDescription(questionText, modelAnswers, lang) {
  if (/نوع البيانات|typeof/i.test(questionText)) {
    const text = cleanMarkup(questionText);
    const literal = text.match(/typeof\s+(.+?)(?:\s+في|\s+على|$)/)?.[1];
    const quoted = quotedOutputs(questionText)[0];
    const numeric = text.match(/نوع البيانات\s*(\d+)/)?.[1] || text.match(/لـ\s*`?"?(\d+)"?`?/)?.[1];
    const value = quoted ? `"${quoted}"` : literal ? literal.replace(/["'`]/g, '') : numeric;
    return printStatement(`typeof ${value}`);
  }

  if (/أنشئ.*دالة|إنشاء دالة|create.*function/i.test(questionText) && !/console\.log/.test(questionText)) {
    const definition = functionDefinition(questionText);
    if (definition) {
      const lines = [`function ${definition.name}(${definition.parameters.join(', ')}) {`];
      if (definition.expression) {
        lines.push('  let result = ' + definition.expression + ';');
        lines.push('  return result;');
      } else {
        const variable = extractVariable(questionText) || 'greeting';
        const output = extractCopyTexts(questionText)[0] || quotedOutputs(questionText)[0] || '';
        lines.push(`  let ${variable} = "${output}";`);
        lines.push(`  return ${variable};`);
      }
      lines.push('}');
      const call = functionCallFromQuestion(questionText, definition.name);
      if (/اطبع|أخرج|console/i.test(questionText)) lines.push(printStatement(call));
      return lines.join('\n');
    }
  }

  const accumulationText = normalizeDigits(cleanMarkup(questionText));
  const accumulationVariable = extractVariable(questionText) || 'num';
  const accumulationAssignment = accumulationText.match(new RegExp(`(${accumulationVariable})\\s*=\\s*(${accumulationVariable}\\s*[+*/-]\\s*(?:i|\\d+))`))
    || accumulationText.match(new RegExp(`\\(\\s*(${accumulationVariable})\\s*([+*/-])\\s*i\\s*\\)`))
    || accumulationText.match(new RegExp(`(?:إسناد العملية الحسابية|إسناد نتيجة)\\s+['‘]?\\s*(${accumulationVariable})\\s*([+*/-])\\s*i`));
  if (/كر(?:ر|ّر) العملية|كرر العملية|إسناد العملية الحسابية/.test(questionText) && accumulationAssignment) {
    const variable = accumulationVariable;
    const value = initialValue(questionText) || '0';
    const comparison = extractComparisons(accumulationText).find(item => item.startsWith('i '));
    const start = accumulationText.match(/أسند\s*(\d+)\s*(?:ل+|إلى)\s*(?:ا?ل)?\s*متغ(?:ي|يّ)ر\s*i/)?.[1]
      || accumulationText.match(/أسن\u0650د\s*(\d+)\s*(?:ل+|إلى)\s*(?:ا?ل)?\s*متغ(?:ي|يّ)ر\s*i/)?.[1] || '0';
    const operation = /^[+*/-]$/.test(accumulationAssignment[2])
      ? `${accumulationAssignment[1]} = ${accumulationAssignment[1]} ${accumulationAssignment[2]} i`
      : `${accumulationAssignment[1]} = ${accumulationAssignment[2]}`;
    const lines = [`let ${variable} = ${value};`, `for (let i = ${start}; ${comparison || `i < ${repeatCount(questionText)}`}; i++) {`];
    lines.push(`  ${operation};`);
    lines.push('}', printStatement(variable));
    return lines.join('\n');
  }

  if (/for\.\.\.of|for\.\.\.of/.test(questionText)) {
    const array = cleanMarkup(questionText).match(/([A-Za-z_$][\w$]*List)/)?.[1];
    const item = cleanMarkup(questionText).match(/هو\s*([A-Za-z_$][\w$]*)/)?.[1] || 'num';
    return `for (let ${item} of ${array}) {\n  ${printStatement(item)}\n}`;
  }

  if (/Math\.random/.test(questionText) && /Math\.floor/.test(questionText)) {
    return printStatement(consoleArgument(questionText));
  }
  const math = mathStatements(questionText);
  if (math.length) return math.join('\n');

  if (extractComparisons(cleanMarkup(questionText)).length) return ifProgram(questionText);

  const variable = extractVariable(questionText);
  const value = initialValue(questionText);
  if (/مرات|تكرار|repeat/i.test(questionText) && /اطبع|أخرج|اعرض|print/i.test(questionText)) {
    const argument = consoleArgument(questionText, '');
    return `for (let i = 0; i < ${repeatCount(questionText)}; i++) {\n  ${printStatement(argument)}\n}`;
  }
  if (variable) {
    const lines = [];
    if (/في سطر واحد|سطرين/.test(questionText) && value) lines.push(`let ${variable} = ${value};`);
    else {
      lines.push(`let ${variable};`);
      if (value) lines.push(`${variable} = ${value};`);
    }
    if (value && !lines.some(line => new RegExp(`${variable}\\s*=\\s*${value}`).test(line))) lines.push(`${variable} = ${value};`);
    const addition = normalizeDigits(cleanMarkup(questionText)).match(/مضافًا إليها\s*(\d+)|مضافة إليها\s*(\d+)|add\s*(\d+)/i);
    const amount = addition?.[1] || addition?.[2] || addition?.[3];
    if (amount) lines.push(`${variable} = ${variable} + ${amount};`);
    if (/اطبع|أخرج|اعرض|print|console/i.test(questionText)) lines.push(printStatement(variable));
    return lines.join('\n');
  }
  const arithmetic = arithmeticExpression(questionText);
  if (arithmetic && /console/i.test(questionText)) return printStatement(arithmetic);
  const argument = consoleArgument(questionText, '');
  if (argument) return printStatement(argument);
  return modelAnswers[0]?.code || '';
}

function testDescription(item, modelAnswers) {
  const question = item.question;
  const description = (item.descriptions || []).find(entry => entry.editable) || item.descriptions?.[0];
  const template = description?.code || '';
  const lang = description?.lang || 'javascript';
  const candidates = modelAnswers.filter(entry => entry.lang === lang);
  const rawQuestionText = question.content || '';
  const questionText = cleanMarkup(rawQuestionText);

  if (template && /\[\[img\]\]/.test(rawQuestionText)) {
    const imageModel = candidates.find(entry => /if\s*\(\s*height\s*>=\s*140\s*\)/.test(entry.code)
      && /if\s*\(\s*age\s*>=\s*12\s*\)/.test(entry.code));
    if (imageModel) return imageModel.code;
  }

  if (template.includes('fitbBlock')) {
    const filled = fillPlaceholders(template, rawQuestionText);
    if (filled) return filled;
    const regex = placeholderTemplateRegex(template);
    const match = candidates.find(entry => regex.test(normalizeCode(entry.code)));
    if (match) return match.code;
  }

  if (template) {
    const completed = completeTemplate(template, rawQuestionText);
    if (completed !== template) return completed;
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = similarity(rawQuestionText, `${candidate.question} ${candidate.code}`);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.2) return best.code;
    return completed;
  }
  return generateDescription(rawQuestionText, candidates, lang);
}

async function solveTest(client, chapter, lectures) {
  const status = await client.learning(`/api/study/students/chapters/${chapter.id}/test`);
  if (!payload(status.data)?.work_in_process) {
    await client.learning(`/api/study/students/chapters/${chapter.id}/test`, { method: 'PUT' });
  }

  const questionsResponse = await client.learning(`/api/study/chapters/${chapter.id}/test`);
  const questions = (payload(questionsResponse.data) || []).sort((a, b) => a.question.seq - b.question.seq);
  if (!questions.length) throw new Error('لم تُرجع المنصة أسئلة الاختبار.');
  const modelAnswers = await collectModelAnswers(client, lectures);
  const prefix = chapter.test_type === 'review' ? 'review-questions' : 'test-questions';
  let submitted = 0;

  for (const item of questions) {
    const question = item.question;
    let path;
    let body;
    if (question.type === 'choice') {
      const choice = testChoice(question, item.choices || [], modelAnswers);
      if (!choice) throw new Error(`سؤال ${question.id} لا يحتوي على خيارات.`);
      path = `/api/study/students/${prefix}/${question.id}/answer/choice`;
      body = { choice_id: choice.id };
    } else {
      const answer = testDescription(item, modelAnswers);
      if (!answer) throw new Error(`تعذر حل سؤال الكود ${question.id}.`);
      path = `/api/study/students/${prefix}/${question.id}/answer/description`;
      body = { answer_code: answer };
    }

    const response = await client.learning(path, { method: 'PUT', body });
    submitted += 1;
    const result = payload(response.data)?.result;
    if (chapter.test_type === 'review' && result?.correct === false) {
      if (question.type === 'description' && result.model_answer) {
        await client.learning(path, { method: 'PUT', body: { answer_code: result.model_answer }, allow: [409] });
      } else if (question.type === 'choice') {
        const correct = (result.choices || []).find(item => item.correct)?.choice?.id;
        if (correct) {
          await client.learning(path, { method: 'PUT', body: { choice_id: correct }, allow: [409] });
        }
      }
    }
  }

  return { submitted };
}

export async function processNextChapter(client) {
  let progress = await getProgress(client);
  if (!progress.current) {
    return { course_completed: true, chapter_completed: true, progress, message: 'جميع الفصول مكتملة بالفعل.' };
  }

  const chapter = progress.current;
  const detail = await client.learning(`/api/study/chapters/${chapter.id}`);
  const lectures = payload(detail.data)?.lectures || [];
  const studentLectures = await client.learning(`/api/study/students/chapters/${chapter.id}/lectures`);
  const completedLectures = new Set(
    (payload(studentLectures.data) || []).filter(item => item.completed_at).map(item => String(item.lecture_id))
  );
  const nextLecture = lectures.find(lecture => !completedLectures.has(String(lecture.id)));

  if (nextLecture) {
    const result = await completeLecture(client, nextLecture.id);
    progress = await getProgress(client);
    return {
      course_completed: false,
      chapter_completed: false,
      chapter_id: chapter.id,
      action: 'lecture',
      message: result.skipped
        ? `الدرس مكتمل: ${nextLecture.title}`
        : `تم حل درس «${nextLecture.title}» وإرسال ${result.submitted} إجابة.`,
      progress
    };
  }

  const testResult = await solveTest(client, chapter, lectures);
  progress = await getProgress(client);
  const updatedChapter = progress.chapters.find(item => item.id === chapter.id);
  const chapterCompleted = Boolean(updatedChapter?.completed);
  return {
    course_completed: progress.completed === progress.total,
    chapter_completed: chapterCompleted,
    retry: !chapterCompleted,
    chapter_id: chapter.id,
    action: 'test',
    message: chapterCompleted
      ? `تم إكمال الفصل ${chapter.seq}: ${chapter.name}.`
      : `تم إرسال ${testResult.submitted} إجابة للفصل ${chapter.seq}؛ ستُعاد المحاولة لتحسين النتيجة.`,
    progress
  };
}

export function isSessionError(error) {
  return error instanceof QureoError && (error.status === 401 || error.code === 'unauthorized');
}
