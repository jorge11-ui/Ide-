# Classroom Code Live

## Configurar o acesso da professora

Na primeira abertura de `/teacher`, a professora cria uma palavra-passe com pelo menos 12 caracteres. Essa primeira configuração é guardada como hash em `server/data/teacher-auth.json`; não é necessário editar ficheiros ou variáveis para começar. A sessão deste navegador persiste por um ano, ou até selecionar **Sair**. Os próximos acessos pedem a palavra-passe escolhida.

Faz essa configuração inicial num computador da professora antes de partilhar a aplicação com a turma. Para alojamento com armazenamento temporário, define credenciais nas variáveis de ambiente do serviço ou configura um disco persistente, para manter o acesso após reinícios.

Opcionalmente, é possível substituir a autenticação local com as variáveis de ambiente `TEACHER_PASSWORD` e `TEACHER_SESSION_SECRET`. Também podes guardar essas variáveis num `server/.env` local, que não é incluído no Git:

```powershell
Copy-Item server\.env.example server\.env
```

Usa HTTPS se o servidor for acessível fora de uma rede local de confiança, para proteger a palavra-passe durante o envio.
