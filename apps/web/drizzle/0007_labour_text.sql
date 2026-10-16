CREATE VIRTUAL TABLE `labour_text` USING fts5(title, brief, description, comments, notes, tokenize = 'porter unicode61');
