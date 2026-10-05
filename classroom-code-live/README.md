# Classroom Code Live

## Configurar o acesso da professora

O painel em `/teacher` e `/teacher.html` exige uma palavra-passe configurada no servidor. Sem ela, o servidor não permite iniciar sessão nem concede o papel de professora aos sockets.

Gera uma chave de sessão uma vez e guarda-a num gestor de segredos:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Antes de iniciar o servidor, define a palavra-passe escolhida e a chave guardada:

```powershell
$env:TEACHER_PASSWORD = "escolhe-uma-palavra-passe-forte"
$env:TEACHER_SESSION_SECRET = "cola-aqui-a-chave-gerada"
Set-Location server
npm start
```

Guarda estes valores num gestor de segredos ou nas variáveis de ambiente do serviço de alojamento; não os coloques no código nem num commit. Se `TEACHER_SESSION_SECRET` não estiver definida, é gerada uma chave temporária ao arrancar o servidor e as sessões existentes deixam de ser válidas após um reinício. As sessões autenticadas expiram após oito horas.

Usa HTTPS se o servidor for acessível fora de uma rede local de confiança, para proteger a palavra-passe durante o envio.
