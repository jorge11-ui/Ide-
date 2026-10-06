    const form = document.getElementById('teacherLogin');
    const password = document.getElementById('password');
    const message = document.getElementById('message');
    const button = form.querySelector('button');
    let setupRequired = false;
    fetch('/teacher-auth-status', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('status');
        const status = await response.json();
        setupRequired = status.setupRequired === true;
        if (setupRequired) {
          document.getElementById('heading').textContent = 'Configurar acesso da professora';
          document.getElementById('description').textContent = 'És a primeira pessoa a configurar este painel. Cria uma palavra-passe com pelo menos 12 caracteres. O acesso fica guardado neste servidor.';
          document.getElementById('passwordLabel').textContent = 'Criar palavra-passe';
          password.autocomplete = 'new-password';
          password.minLength = 12;
          button.textContent = 'Configurar e entrar';
        }
        password.disabled = false;
        button.disabled = false;
      })
      .catch(() => { message.textContent = 'Não foi possível verificar a configuração do servidor.'; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      message.textContent = setupRequired ? 'A guardar a configuração…' : 'A verificar…';
      try {
        const response = await fetch('/teacher-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.value })
        });
        const result = await response.json();
        if (!response.ok) {
          message.textContent = result.message || 'Não foi possível iniciar sessão.';
          if (response.status === 409) location.reload();
          return;
        }
        location.reload();
      } catch (error) {
        message.textContent = 'Não foi possível contactar o servidor.';
      } finally {
        button.disabled = false;
      }
    });
