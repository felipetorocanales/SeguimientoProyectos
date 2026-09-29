/**
 * aiService.js - Integración de IA Local con Ollama para Nexus Tracker
 *
 * Lee la URL y Modelo desde variables de entorno (.env) con fallback a localStorage
 * para permitir actualización dinámica directa desde la interfaz sin recompilar.
 */

const DEFAULT_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OLLAMA_URL) || 'https://atm-harvest-matching-bass.trycloudflare.com';
const DEFAULT_MODEL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OLLAMA_MODEL) || 'qwen2.5:7b';

/**
 * Obtiene la configuración activa de Ollama
 */
export function getOllamaConfig() {
  const savedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('ollama_url') : null;
  const savedModel = typeof localStorage !== 'undefined' ? localStorage.getItem('ollama_model') : null;

  const url = (savedUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  const model = (savedModel || DEFAULT_MODEL).trim();
  return { url, model };
}

/**
 * Guarda la configuración de Ollama en localStorage
 */
export function saveOllamaConfig(url, model) {
  const cleanUrl = (url || '').trim().replace(/\/+$/, '');
  const cleanModel = (model || '').trim();
  if (typeof localStorage !== 'undefined') {
    if (cleanUrl) localStorage.setItem('ollama_url', cleanUrl);
    if (cleanModel) localStorage.setItem('ollama_model', cleanModel);
  }
  return { url: cleanUrl || DEFAULT_URL, model: cleanModel || DEFAULT_MODEL };
}

/**
 * Prueba la conectividad con el servidor de Ollama
 */
export async function testOllamaConnection(targetUrl = null, targetModel = null) {
  const { url: configUrl, model: configModel } = getOllamaConfig();
  const url = (targetUrl || configUrl).trim().replace(/\/+$/, '');
  const model = (targetModel || configModel).trim();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${url}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        success: false,
        message: `El servidor respondió con código ${res.status}: ${res.statusText}. Verifica que el túnel esté activo.`
      };
    }

    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model);
    const hasModel = models.some(m => m === model || m.startsWith(model + ':') || (model.includes(':') && m === model.split(':')[0]));

    if (models.length === 0) {
      return {
        success: true,
        message: `Conectado a Ollama, pero no se detectaron modelos descargados.`
      };
    }

    return {
      success: true,
      models,
      hasRequestedModel: hasModel,
      message: hasModel
        ? `¡Conexión exitosa! Modelo "${model}" detectado y listo.`
        : `Conectado, pero el modelo "${model}" no fue encontrado. Modelos disponibles: ${models.join(', ')}`
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        success: false,
        message: `Tiempo de espera agotado al conectar con ${url}. Verifica si el túnel está corriendo.`
      };
    }
    return {
      success: false,
      message: `No se pudo conectar a Ollama (${err.message || 'Error de red / CORS'}). Asegúrate de ejecutar 'OLLAMA_ORIGINS="*" ollama serve'.`
    };
  }
}

/**
 * Genera contenido utilizando Ollama
 * @param {string} prompt - Prompt para el modelo
 * @param {object} options - { format: 'json', system: '...' }
 * @returns {Promise<string>}
 */
export async function generateAIContent(prompt, options = {}) {
  const { url, model } = getOllamaConfig();
  if (!url) {
    throw new Error("No hay una URL configurada para el servidor Ollama. Ve a Ajustes para configurarla.");
  }

  const payload = {
    model: model || 'qwen2.5:7b',
    prompt: prompt,
    stream: false
  };

  if (options.format) {
    payload.format = options.format;
  }
  if (options.system) {
    payload.system = options.system;
  }

  const controller = new AbortController();
  // Tiempo de espera de 120 segundos para modelos locales
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`El modelo "${model}" no existe en tu Ollama. Descárgalo en tu Mac con 'ollama run ${model}'.`);
      }
      if (res.status === 530) {
        throw new Error(`Error 530 de Cloudflare: El túnel está caído o el link expiró. Inicia un nuevo túnel y actualiza el link en Ajustes.`);
      }
      throw new Error(`Error ${res.status} desde Ollama: ${res.statusText}`);
    }

    const data = await res.json();
    return (data.response || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`La IA tardó más de 120 segundos en responder. Puede que el modelo esté sobrecargado o el Mac en suspensión.`);
    }
    if (err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
      throw new Error(`No se pudo conectar con Ollama en ${url}. Verifica si el túnel Cloudflare sigue activo o si Ollama tiene CORS habilitado (OLLAMA_ORIGINS="*").`);
    }
    throw err;
  }
}
