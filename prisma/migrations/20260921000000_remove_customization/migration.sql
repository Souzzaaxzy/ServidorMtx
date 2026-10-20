-- Remove o sistema de PERSONALIZAÇÃO (molduras, cor de nome e afins).
--
-- WHY: o recurso foi retirado do produto. Manter as tabelas só acumularia
-- linhas que nada lê, e o código que as consultava já não existe.
--
-- Ordem: as tabelas FILHAS primeiro (equipped_items e user_items referenciam
-- items). Sem isso o DROP da tabela pai falharia com foreign keys ativas.
DROP TABLE IF EXISTS "equipped_items";
DROP TABLE IF EXISTS "user_items";
DROP TABLE IF EXISTS "items";
