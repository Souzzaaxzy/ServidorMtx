-- Normaliza usernames legados que possam ter sido gravados com '@' no
-- início (ex.: '@leozin' -> 'leozin').
--
-- Estratégia:
-- 1) Colisões: se existir '@user' e 'user' (sem '@'), o '@user' recebe o
--    sufixo '_legacy' para não violar a UNIQUE de username, e NUNCA se
--    duplica/mescla usuário.
-- 2) Depois remove o '@' inicial dos que não colidirem.
--
-- Apenas o(s) '@' inicia(is) são removidos; demais caracteres intocados.

-- 1) Marca colisões com sufixo determinístico
UPDATE "users"
SET username = substr(username, 2) || '_legacy'
WHERE username LIKE '@%'
  AND EXISTS (
    SELECT 1 FROM "users" AS u2
    WHERE u2.username = substr("users".username, 2)
  );

-- 2) Remoção do '@' inicial dos demais
UPDATE "users"
SET username = substr(username, 2)
WHERE username LIKE '@%';
